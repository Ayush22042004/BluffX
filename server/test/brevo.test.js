const test = require("node:test");
const assert = require("node:assert/strict");
const { createMailer } = require("../src/mailer");
const env = {
  NODE_ENV: "production",
  MAIL_PROVIDER: "brevo",
  BREVO_API_KEY: "private-test-key",
  MAIL_FROM: "BluffX <sender@example.com>",
};
const message = {
  to: "player@example.com",
  subject: "Verify your email",
  text: "Your private verification link",
};

test("Brevo uses the HTTPS API with stable UUID deduplication and no SMTP transport", async () => {
  const calls = [];
  const mailer = createMailer({
    env,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => ({ messageId: "brevo-123" }) };
    },
    smtpFactory: () => {
      throw Error("SMTP forbidden");
    },
  });
  for (let i = 0; i < 2; i++)
    assert.deepEqual(
      await mailer.send(message, {
        idempotencyKey: "report-stable-reference",
        from: "BluffX <frozen@example.com>",
      }),
      { id: "brevo-123" },
    );
  const first = calls[0],
    body = JSON.parse(first.options.body);
  assert.equal(first.url, "https://api.brevo.com/v3/smtp/email");
  assert.equal(first.options.redirect, "error");
  assert.equal(first.options.headers["api-key"], "private-test-key");
  assert.deepEqual(body.sender, {
    name: "BluffX",
    email: "frozen@example.com",
  });
  assert.deepEqual(body.to, [{ email: message.to }]);
  assert.equal(body.textContent, message.text);
  assert.match(
    body.headers.idempotencyKey,
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
  assert.equal(
    JSON.parse(calls[1].options.body).headers.idempotencyKey,
    body.headers.idempotencyKey,
  );
  assert.ok(first.options.signal instanceof AbortSignal);
  assert.equal(mailer.idempotencyWindowMs, 25 * 60000);
});
test("Brevo recognizes a deduplicated request without claiming inbox delivery", async () => {
  const mailer = createMailer({
    env,
    fetchImpl: async () => ({
      ok: false,
      status: 400,
      json: async () => ({ code: "duplicate_parameter" }),
    }),
  });
  assert.match(
    (await mailer.send(message, { idempotencyKey: "stable" })).id,
    /^brevo-deduplicated-/,
  );
});
test("Brevo fails safely for missing config, invalid sender, provider errors and network failures", async () => {
  for (const config of [
    { ...env, BREVO_API_KEY: "" },
    { ...env, MAIL_FROM: "" },
  ])
    assert.equal(createMailer({ env: config }).mode, "unavailable");
  const invalid = createMailer({
    env: { ...env, MAIL_FROM: "bad\r\nInjected: sender" },
    fetchImpl: () => {
      throw Error("must not call provider");
    },
  });
  await assert.rejects(() => invalid.send(message), /Invalid email address/);
  for (const fetchImpl of [
    async () => ({
      ok: false,
      status: 403,
      json: async () => ({ message: "private-test-key SECRET" }),
    }),
    async () => {
      throw Error("private-test-key");
    },
    async () => ({ ok: true, json: async () => ({}) }),
  ]) {
    await assert.rejects(
      () => createMailer({ env, fetchImpl }).send(message),
      (e) =>
        e.code === "EMAIL_DELIVERY_UNAVAILABLE" &&
        !/private-test-key|SECRET/.test(e.message),
    );
  }
  assert.equal(
    createMailer({
      env: { ...env, MAIL_PROVIDER: "auto", RESEND_API_KEY: "old-key" },
    }).mode,
    "brevo",
  );
});
