const test = require("node:test");
const assert = require("node:assert/strict");
const { createMailer } = require("../src/mailer");
const message = {
  to: "player@example.com",
  subject: "Verify your BluffX email",
  text: "Visit https://bluffx.example/?auth=verify&token=private-token",
};
const env = {
  NODE_ENV: "production",
  MAIL_PROVIDER: "resend",
  RESEND_API_KEY: "test-only-key",
  MAIL_FROM: "BluffX <play@bluffx.example>",
};
test("Resend sends mail via HTTPS with server-side authorization and an idempotency key", async () => {
  let request;
  const mailer = createMailer({
    env,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ id: "email-123" }) };
    },
    smtpFactory: () => {
      throw Error("SMTP must not be used");
    },
  });
  assert.equal(mailer.mode, "resend");
  assert.deepEqual(await mailer.send(message), { id: "email-123" });
  assert.equal(request.url, "https://api.resend.com/emails");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.redirect, "error");
  assert.equal(request.options.headers.Authorization, "Bearer test-only-key");
  assert.match(request.options.headers["Idempotency-Key"], /^bluffx-/);
  assert.ok(request.options.signal instanceof AbortSignal);
  const body = JSON.parse(request.options.body);
  assert.equal(body.from, env.MAIL_FROM);
  assert.deepEqual(body.to, [message.to]);
  assert.equal(body.text, message.text);
  assert.equal(body.subject, message.subject);
});
test("auto mode prefers Resend over configured SMTP", () => {
  const mailer = createMailer({
    env: { ...env, MAIL_PROVIDER: "auto", SMTP_HOST: "smtp.example.com" },
    smtpFactory: () => {
      throw Error("Must not open SMTP on Resend");
    },
  });
  assert.equal(mailer.mode, "resend");
});
test("provider errors and network failures do not expose provider messages or API keys", async () => {
  for (const fetchImpl of [
    async () => ({
      ok: false,
      status: 401,
      json: async () => ({
        message: "private provider text and test-only-key",
      }),
    }),
    async () => {
      throw Error("test-only-key network details");
    },
    async () => ({ ok: true, json: async () => ({}) }),
  ]) {
    const mailer = createMailer({ env, fetchImpl });
    await assert.rejects(
      () => mailer.send(message),
      (error) => {
        assert.equal(error.status, 503);
        assert.equal(error.code, "EMAIL_DELIVERY_UNAVAILABLE");
        assert.doesNotMatch(error.message, /test-only-key|private provider/);
        return true;
      },
    );
  }
});
test("email API calls are aborted if the provider does not respond", async () => {
  const mailer = createMailer({
    env,
    timeoutMs: 10,
    fetchImpl: (_url, { signal }) =>
      new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason)),
      ),
  });
  const keepAlive = setTimeout(() => {}, 200);
  try {
    await assert.rejects(() => mailer.send(message), {
      status: 503,
      code: "EMAIL_DELIVERY_UNAVAILABLE",
    });
  } finally {
    clearTimeout(keepAlive);
  }
});
test("production requires configured delivery and refuses local-preview mode", async () => {
  assert.throws(
    () =>
      createMailer({ env: { NODE_ENV: "production", MAIL_PROVIDER: "local" } }),
    /cannot be used in production/,
  );
  assert.throws(
    () => createMailer({ env: { MAIL_PROVIDER: "typo" } }),
    /MAIL_PROVIDER/,
  );
  for (const config of [
    { NODE_ENV: "production" },
    { NODE_ENV: "production", MAIL_PROVIDER: "resend" },
    { NODE_ENV: "production", RESEND_API_KEY: "key-without-sender" },
  ]) {
    const mailer = createMailer({ env: config });
    assert.equal(mailer.mode, "unavailable");
    await assert.rejects(() => mailer.send(message), { status: 503 });
  }
  assert.equal(createMailer({ env: {} }).mode, "local");
});
test("SMTP remains an explicitly supported alternative", async () => {
  let settings, payload;
  const mailer = createMailer({
    env: {
      MAIL_PROVIDER: "smtp",
      SMTP_HOST: "smtp.example.com",
      SMTP_PORT: "465",
      SMTP_SECURE: "true",
      SMTP_USER: "user",
      SMTP_PASS: "secret",
      MAIL_FROM: "sender@example.com",
    },
    smtpFactory: (options) => {
      settings = options;
      return {
        sendMail: async (message) => {
          payload = message;
          return { messageId: "smtp-123" };
        },
      };
    },
  });
  assert.equal(mailer.mode, "smtp");
  assert.deepEqual(await mailer.send(message), { messageId: "smtp-123" });
  assert.equal(settings.host, "smtp.example.com");
  assert.equal(settings.secure, true);
  assert.equal(settings.port, 465);
  assert.equal(payload.from, "sender@example.com");
  assert.equal(payload.text, message.text);
});
