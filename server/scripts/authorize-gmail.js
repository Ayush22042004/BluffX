// Owner-only, loopback authorization. No Gmail credentials enter browser code.
require("../src/environment").loadEnvironment();
const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { OAuth2Client } = require("google-auth-library");
const { TOKEN_FILE, SCOPE } = require("../src/gmail-api");
async function main() {
  const {
    GMAIL_CLIENT_ID: clientId,
    GMAIL_CLIENT_SECRET: clientSecret,
    GMAIL_USER: user,
  } = process.env;
  if (!clientId || !clientSecret || !user)
    throw Error(
      "Set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET and GMAIL_USER in server/.env first.",
    );
  const redirect = "http://127.0.0.1:4055/";
  const client = new OAuth2Client({
    clientId,
    clientSecret,
    redirectUri: redirect,
    transporterOptions: { timeout: 15000 },
  });
  const state = crypto.randomBytes(32).toString("hex");
  const verifier = crypto.randomBytes(32).toString("base64url");
  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent select_account",
    scope: [SCOPE, "openid", "email"],
    state,
    code_challenge: crypto
      .createHash("sha256")
      .update(verifier)
      .digest("base64url"),
    code_challenge_method: "S256",
  });
  let processing = false;
  await new Promise((resolve, reject) => {
    let timer;
    const server = http.createServer(async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      if (req.method !== "GET" || req.headers.host !== "127.0.0.1:4055") {
        res.writeHead(400);
        res.end("Invalid local request.");
        return;
      }
      const url = new URL(req.url, redirect);
      if (url.pathname === "/start") {
        res.writeHead(302, { Location: authUrl });
        res.end();
        return;
      }
      if (url.pathname !== "/") {
        res.writeHead(404);
        res.end();
        return;
      }
      const returned = url.searchParams.get("state") || "";
      if (
        returned.length !== state.length ||
        !crypto.timingSafeEqual(Buffer.from(returned), Buffer.from(state)) ||
        processing
      ) {
        res.writeHead(400);
        res.end("Invalid or already-used authorization response.");
        return;
      }
      processing = true;
      try {
        if (url.searchParams.has("error") || !url.searchParams.get("code"))
          throw Error("Authorization was not granted.");
        const { tokens } = await client.getToken({
          code: url.searchParams.get("code"),
          codeVerifier: verifier,
        });
        if (
          !tokens.refresh_token ||
          !tokens.id_token ||
          !tokens.scope?.split(" ").includes(SCOPE)
        )
          throw Error(
            "Google did not grant offline sending access. Reauthorize the sender.",
          );
        const ticket = await client.verifyIdToken({
          idToken: tokens.id_token,
          audience: clientId,
        });
        const identity = ticket.getPayload();
        if (
          !identity.email_verified ||
          identity.email?.toLowerCase() !== user.trim().toLowerCase()
        )
          throw Error("Authorize the account configured in GMAIL_USER.");
        await fs.mkdir(path.dirname(TOKEN_FILE), { recursive: true });
        await fs.writeFile(
          TOKEN_FILE,
          JSON.stringify(
            {
              clientId,
              email: identity.email,
              refreshToken: tokens.refresh_token,
            },
            null,
            2,
          ),
          { mode: 0o600 },
        );
        res.end(
          "BluffX Gmail sender authorized. Return to your terminal. You can close this tab.",
        );
        console.log(
          "Sender authorization saved privately in server/.data/gmail-oauth.json. No token was printed.",
        );
        clearTimeout(timer);
        server.close();
        server.closeIdleConnections();
        resolve();
      } catch (error) {
        res.writeHead(400);
        res.end(
          "Authorization failed. Check the configured account and Gmail API access, then rerun the command.",
        );
        clearTimeout(timer);
        server.close();
        server.closeIdleConnections();
        reject(
          new Error(
            error.message === "Authorize the account configured in GMAIL_USER."
              ? error.message
              : "Google sender authorization failed. Check OAuth configuration and account access.",
          ),
        );
      }
    });
    server.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    server.listen(4055, "127.0.0.1", () =>
      console.log(
        "Open http://127.0.0.1:4055/start in your browser and authorize the configured sender. Waiting up to five minutes.",
      ),
    );
    timer = setTimeout(() => {
      server.close();
      server.closeAllConnections();
      reject(
        new Error(
          "Authorization timed out. Rerun npm run gmail:authorize when ready.",
        ),
      );
    }, 300000);
    server.once("close", () => clearTimeout(timer));
  });
}
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { main };
