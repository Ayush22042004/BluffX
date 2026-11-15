const fs = require("node:fs");
const path = require("node:path");
const MailComposer = require("nodemailer/lib/mail-composer");
const TOKEN_FILE = path.resolve(__dirname, "../.data/gmail-oauth.json");
const SCOPE = "https://www.googleapis.com/auth/gmail.send";
const fail = (message, status) =>
  Object.assign(new Error(message), {
    code: "EMAIL_DELIVERY_UNAVAILABLE",
    status: 503,
    ...(status ? { providerStatus: status } : {}),
  });
function gmailConfig(env) {
  let refreshToken = env.GMAIL_REFRESH_TOKEN?.trim();
  if (
    !refreshToken &&
    env.NODE_ENV !== "production" &&
    env.GMAIL_CLIENT_ID &&
    env.GMAIL_CLIENT_SECRET
  ) {
    try {
      const saved = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
      if (
        saved.clientId === env.GMAIL_CLIENT_ID &&
        saved.email?.toLowerCase() === env.GMAIL_USER?.trim().toLowerCase()
      )
        refreshToken = saved.refreshToken;
    } catch {
      /* Missing local authorization is reported as unavailable. */
    }
  }
  return {
    clientId: env.GMAIL_CLIENT_ID?.trim(),
    clientSecret: env.GMAIL_CLIENT_SECRET?.trim(),
    user: env.GMAIL_USER?.trim().toLowerCase(),
    refreshToken,
  };
}
function createGmailSender({
  config,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10000,
  now = Date.now,
}) {
  let cached, refreshing;
  async function accessToken() {
    if (cached?.until > now()) return cached.token;
    if (!refreshing)
      refreshing = (async () => {
        const response = await fetchImpl(
          "https://oauth2.googleapis.com/token",
          {
            method: "POST",
            redirect: "error",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              client_id: config.clientId,
              client_secret: config.clientSecret,
              refresh_token: config.refreshToken,
              grant_type: "refresh_token",
            }).toString(),
            signal: AbortSignal.timeout(timeoutMs),
          },
        );
        if (!response.ok)
          throw fail(
            "Gmail sender authorization failed. Reauthorize the sender account.",
            response.status,
          );
        const result = await response.json();
        if (
          typeof result.access_token !== "string" ||
          !Number.isFinite(Number(result.expires_in)) ||
          Number(result.expires_in) <= 0
        )
          throw fail("Gmail returned an invalid authorization response.");
        cached = {
          token: result.access_token,
          until: now() + Math.max(0, Number(result.expires_in) * 1000 - 60000),
        };
        return cached.token;
      })().finally(() => {
        refreshing = null;
      });
    return refreshing;
  }
  return async (message) => {
    try {
      const from = String(message.from || "");
      const sender = (from.match(/<([^<>]+)>$/)?.[1] || from)
        .trim()
        .toLowerCase();
      const to = Array.isArray(message.to) ? message.to : [message.to];
      if (
        /[\r\n]/.test(from) ||
        sender !== config.user ||
        !to.length ||
        to.some(
          (value) =>
            typeof value !== "string" ||
            !/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(value),
        )
      )
        throw fail(
          "Use the authorized Gmail address in MAIL_FROM and valid recipient addresses.",
        );
      const raw = await new MailComposer({
        from,
        to,
        subject: message.subject,
        text: message.text,
        disableFileAccess: true,
        disableUrlAccess: true,
      })
        .compile()
        .build();
      const token = await accessToken();
      const response = await fetchImpl(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        {
          method: "POST",
          redirect: "error",
          headers: {
            Authorization: "Bearer " + token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ raw: raw.toString("base64url") }),
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
      if (!response.ok) {
        if (response.status === 401) cached = null;
        throw fail(
          "Gmail could not accept the email. Check authorization and account sending limits.",
          response.status,
        );
      }
      const result = await response.json();
      if (typeof result.id !== "string" || !result.id)
        throw fail("Gmail returned an unexpected response.");
      return { id: result.id };
    } catch (error) {
      if (error.code === "EMAIL_DELIVERY_UNAVAILABLE") throw error;
      throw fail(
        "Gmail delivery could not be confirmed. Check sender authorization and connectivity.",
      );
    }
  };
}
module.exports = { gmailConfig, createGmailSender, TOKEN_FILE, SCOPE };
