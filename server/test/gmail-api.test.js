const test = require("node:test");
const assert = require("node:assert/strict");
const { createMailer } = require("../src/mailer");
const env = {
  NODE_ENV: "production",
  MAIL_PROVIDER: "gmail",
  GMAIL_CLIENT_ID: "test-client",
  GMAIL_CLIENT_SECRET: "private-client-secret",
  GMAIL_REFRESH_TOKEN: "private-refresh-token",
  GMAIL_USER: "owner@gmail.com",
  MAIL_FROM: "BluffX <owner@gmail.com>",
};
const message = {
  to: "player@example.com",
  subject: "Verify your email",
  text: "Visit https://bluffx.example/?auth=verify&token=private-link",
};
test("Gmail sends RFC email over HTTPS and shares one cached refresh across concurrent sends", async () => {
  const calls = [];
  const mailer = createMailer({
    env,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        json: async () =>
          url.includes("oauth2.")
            ? { access_token: "private-access-token", expires_in: 3600 }
            : { id: "gmail-accepted" },
      };
    },
    smtpFactory: () => {
      throw Error("SMTP forbidden");
    },
  });
  const sent = await Promise.all([mailer.send(message), mailer.send(message)]);
  assert.deepEqual(sent, [{ id: "gmail-accepted" }, { id: "gmail-accepted" }]);
  assert.equal(mailer.mode, "gmail");
  assert.equal(mailer.idempotencyWindowMs, 0);
  const refresh = calls.filter((c) => c.url.includes("oauth2."));
  assert.equal(refresh.length, 1);
  const parameters = new URLSearchParams(refresh[0].options.body);
  assert.equal(parameters.get("grant_type"), "refresh_token");
  assert.equal(parameters.get("refresh_token"), "private-refresh-token");
  const send = calls.find((c) => c.url.includes("gmail.googleapis.com"));
  assert.equal(
    send.url,
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
  );
  assert.equal(
    send.options.headers.Authorization,
    "Bearer private-access-token",
  );
  assert.equal(send.options.redirect, "error");
  const raw = Buffer.from(
    JSON.parse(send.options.body).raw,
    "base64url",
  ).toString("utf8");
  assert.match(raw, /From: BluffX <owner@gmail.com>/);
  assert.match(raw, /To: player@example.com/);
  assert.match(raw, /Subject: Verify your email/);
  assert.doesNotMatch(
    send.options.body,
    /private-refresh-token|private-client-secret/,
  );
});
test("Gmail refuses missing credentials, unauthorized senders and unconfirmed sends without leaking secrets", async () => {
  assert.equal(
    createMailer({ env: { ...env, GMAIL_REFRESH_TOKEN: "" } }).mode,
    "unavailable",
  );
  const validToken = {
    ok: true,
    json: async () => ({ access_token: "secret", expires_in: 3600 }),
  };
  let sends = 0;
  const mailer = createMailer({
    env,
    fetchImpl: async (url) => {
      if (url.includes("oauth2.")) return validToken;
      sends++;
      return {
        ok: false,
        status: 403,
        json: async () => ({ message: "private-refresh-token" }),
      };
    },
  });
  await assert.rejects(
    () =>
      mailer.send(
        { ...message, from: "other@gmail.com" },
        { from: "other@gmail.com" },
      ),
    /authorized Gmail/,
  );
  assert.equal(sends, 0);
  await assert.rejects(
    () => mailer.send(message),
    (e) =>
      e.code === "EMAIL_DELIVERY_UNAVAILABLE" &&
      !/private-refresh-token/.test(e.message),
  );
  assert.equal(sends, 1);
  const invalid = createMailer({
    env,
    fetchImpl: async () => ({
      ok: false,
      status: 400,
      json: async () => ({
        error: "invalid_grant",
        secret: "private-refresh-token",
      }),
    }),
  });
  await assert.rejects(
    () => invalid.send(message),
    (e) =>
      e.code === "EMAIL_DELIVERY_UNAVAILABLE" &&
      !/private-refresh-token/.test(e.message),
  );
});
