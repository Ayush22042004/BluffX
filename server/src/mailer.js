const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const nodemailer = require("nodemailer");
const unavailable = (message) =>
  Object.assign(new Error(message), {
    status: 503,
    code: "EMAIL_DELIVERY_UNAVAILABLE",
  });
function createMailer({
  env = process.env,
  outboxPath = path.resolve(__dirname, "../.data/mail"),
  fetchImpl = globalThis.fetch,
  smtpFactory = nodemailer.createTransport,
  timeoutMs = 10000,
} = {}) {
  const provider = (env.MAIL_PROVIDER || "auto").trim().toLowerCase();
  if (!["auto", "resend", "smtp", "local"].includes(provider))
    throw Error("MAIL_PROVIDER must be auto, resend, smtp, or local.");
  const production = env.NODE_ENV === "production";
  if (provider === "local" && production)
    throw Error(
      "Local email previews cannot be used in production. Configure Resend or SMTP.",
    );
  let mode =
    provider === "auto"
      ? env.RESEND_API_KEY
        ? "resend"
        : env.SMTP_HOST
          ? "smtp"
          : production
            ? "unavailable"
            : "local"
      : provider;
  let configurationError = "Email delivery has not been configured.";
  if (
    mode === "resend" &&
    (!env.RESEND_API_KEY?.trim() || !env.MAIL_FROM?.trim())
  ) {
    mode = "unavailable";
    configurationError =
      "Configure RESEND_API_KEY and MAIL_FROM to enable email delivery.";
  }
  if (mode === "smtp" && !env.SMTP_HOST) {
    mode = "unavailable";
    configurationError = "Configure SMTP_HOST to enable SMTP email delivery.";
  }
  const transport =
    mode === "smtp"
      ? smtpFactory({
          host: env.SMTP_HOST,
          port: Number(env.SMTP_PORT || 587),
          secure: env.SMTP_SECURE === "true",
          auth: env.SMTP_USER
            ? { user: env.SMTP_USER, pass: env.SMTP_PASS }
            : undefined,
          connectionTimeout: 10000,
          socketTimeout: 15000,
        })
      : null;
  return {
    mode,
    async send(message) {
      if (mode === "unavailable") throw unavailable(configurationError);
      const payload = {
        ...message,
        from: env.MAIL_FROM?.trim() || "BluffX <no-reply@bluffx.local>",
      };
      if (mode === "resend") {
        try {
          const response = await fetchImpl("https://api.resend.com/emails", {
            method: "POST",
            redirect: "error",
            headers: {
              Authorization: `Bearer ${env.RESEND_API_KEY.trim()}`,
              "Content-Type": "application/json",
              "Idempotency-Key": `bluffx-${crypto.randomUUID()}`,
            },
            body: JSON.stringify({
              ...payload,
              to: Array.isArray(payload.to) ? payload.to : [payload.to],
            }),
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (!response.ok)
            throw unavailable(
              "Email provider could not accept the message. Check the API key and verified sender, then try again.",
            );
          const result = await response.json();
          if (!result.id)
            throw unavailable(
              "Email provider returned an unexpected response. Please try again.",
            );
          return { id: result.id };
        } catch (error) {
          if (error.code === "EMAIL_DELIVERY_UNAVAILABLE") throw error;
          throw unavailable(
            "Email provider is temporarily unreachable. Please try again.",
          );
        }
      }
      if (transport) {
        try {
          return await transport.sendMail(payload);
        } catch {
          throw unavailable(
            "Email delivery failed. Check the mail provider settings and try again.",
          );
        }
      }
      await fs.mkdir(outboxPath, { recursive: true });
      await fs.writeFile(
        path.join(outboxPath, crypto.randomUUID() + ".json"),
        JSON.stringify(payload, null, 2),
        { mode: 0o600 },
      );
      return { local: true };
    },
  };
}
module.exports = { createMailer };
