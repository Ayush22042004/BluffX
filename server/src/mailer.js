const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const nodemailer = require("nodemailer");
const { gmailConfig, createGmailSender } = require("./gmail-api");
const unavailable = (message) =>
  Object.assign(new Error(message), {
    status: 503,
    code: "EMAIL_DELIVERY_UNAVAILABLE",
  });
function brevoAddress(value) {
  if (typeof value !== "string" || /[\r\n]/.test(value))
    throw unavailable("Invalid email address configuration.");
  const match = value.trim().match(/^(?:(.*?)\s*<([^<>]+)>|([^<>]+))$/);
  const email = (match?.[2] || match?.[3] || "").trim();
  if (!/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(email))
    throw unavailable("Invalid email address configuration.");
  const name = match?.[1]?.trim();
  return { email, ...(name ? { name } : {}) };
}
function brevoKey(key) {
  const bytes = crypto
    .createHash("sha256")
    .update("bluffx/brevo/" + key)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function createMailer({
  env = process.env,
  outboxPath = path.resolve(__dirname, "../.data/mail"),
  fetchImpl = globalThis.fetch,
  smtpFactory = nodemailer.createTransport,
  timeoutMs = 10000,
} = {}) {
  const provider = (env.MAIL_PROVIDER || "auto").trim().toLowerCase();
  if (!["auto", "gmail", "brevo", "resend", "smtp", "local"].includes(provider))
    throw Error(
      "MAIL_PROVIDER must be auto, gmail, brevo, resend, smtp, or local.",
    );
  const production = env.NODE_ENV === "production";
  if (provider === "local" && production)
    throw Error(
      "Local email previews cannot be used in production. Configure an HTTPS email provider or SMTP.",
    );
  const gmail = gmailConfig(env);
  let mode =
    provider === "auto"
      ? gmail.refreshToken
        ? "gmail"
        : env.BREVO_API_KEY
          ? "brevo"
          : env.RESEND_API_KEY
            ? "resend"
            : env.SMTP_HOST
              ? "smtp"
              : production
                ? "unavailable"
                : "local"
      : provider;
  let configurationError = "Email delivery has not been configured.";
  if (
    mode === "gmail" &&
    (!gmail.clientId ||
      !gmail.clientSecret ||
      !gmail.refreshToken ||
      !gmail.user ||
      !env.MAIL_FROM?.trim())
  ) {
    mode = "unavailable";
    configurationError =
      "Configure the Gmail API sender and authorize its account before sending email.";
  }
  const gmailSend =
    mode === "gmail"
      ? createGmailSender({ config: gmail, fetchImpl, timeoutMs })
      : null;
  if (
    mode === "brevo" &&
    (!env.BREVO_API_KEY?.trim() || !env.MAIL_FROM?.trim())
  ) {
    mode = "unavailable";
    configurationError =
      "Configure BREVO_API_KEY and MAIL_FROM to enable email delivery.";
  }
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
    idempotencyWindowMs:
      mode === "brevo"
        ? 25 * 60000
        : ["smtp", "gmail"].includes(mode)
          ? 0
          : 23 * 3600000,
    sender: env.MAIL_FROM?.trim() || "BluffX <no-reply@bluffx.local>",
    async send(message, options = {}) {
      if (
        options.idempotencyKey &&
        !/^[a-zA-Z0-9:_/-]{1,200}$/.test(options.idempotencyKey)
      )
        throw unavailable("Invalid email delivery identifier.");
      if (mode === "unavailable") throw unavailable(configurationError);
      const payload = {
        ...message,
        from:
          options.from ||
          env.MAIL_FROM?.trim() ||
          "BluffX <no-reply@bluffx.local>",
      };
      if (gmailSend) return gmailSend(payload);
      if (mode === "brevo") {
        try {
          const key = brevoKey(options.idempotencyKey || crypto.randomUUID());
          const response = await fetchImpl(
            "https://api.brevo.com/v3/smtp/email",
            {
              method: "POST",
              redirect: "error",
              headers: {
                "api-key": env.BREVO_API_KEY.trim(),
                "Content-Type": "application/json",
                Accept: "application/json",
              },
              body: JSON.stringify({
                sender: brevoAddress(payload.from),
                to: (Array.isArray(payload.to) ? payload.to : [payload.to]).map(
                  brevoAddress,
                ),
                subject: payload.subject,
                textContent: payload.text,
                headers: { idempotencyKey: key },
              }),
              signal: AbortSignal.timeout(timeoutMs),
            },
          );
          const result = await response.json().catch(() => ({}));
          if (!response.ok) {
            if (
              response.status === 400 &&
              result.code === "duplicate_parameter"
            )
              return { id: "brevo-deduplicated-" + key };
            throw Object.assign(
              unavailable(
                "Email provider could not accept the message. Check sender verification and API access.",
              ),
              { providerStatus: response.status },
            );
          }
          const id = result.messageId || result.messageIds?.[0];
          if (typeof id !== "string" || !id)
            throw unavailable(
              "Email provider returned an unexpected response. Please try again.",
            );
          return { id };
        } catch (error) {
          if (error.code === "EMAIL_DELIVERY_UNAVAILABLE") throw error;
          throw unavailable(
            "Email provider is temporarily unreachable. Please try again.",
          );
        }
      }
      if (mode === "resend") {
        try {
          const response = await fetchImpl("https://api.resend.com/emails", {
            method: "POST",
            redirect: "error",
            headers: {
              Authorization: `Bearer ${env.RESEND_API_KEY.trim()}`,
              "Content-Type": "application/json",
              "Idempotency-Key":
                options.idempotencyKey || `bluffx-${crypto.randomUUID()}`,
            },
            body: JSON.stringify({
              ...payload,
              to: Array.isArray(payload.to) ? payload.to : [payload.to],
            }),
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (!response.ok)
            throw Object.assign(
              unavailable(
                "Email provider could not accept the message. Check the API key and verified sender, then try again.",
              ),
              { providerStatus: response.status },
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
