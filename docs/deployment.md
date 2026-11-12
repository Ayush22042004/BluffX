# Deploy BluffX on Render and Vercel

The GitHub repository is https://github.com/Ayush22042004/BluffX. Account data is already in Neon PostgreSQL. Keep a single backend instance: live rooms and turn timers are in memory.

The frontend is deployed at **https://bluffx.vercel.app** and the backend at **https://bluffx.onrender.com**. Vercel's production `VITE_SERVER_URL` is **https://bluffx.vercel.app**: authentication and Socket.IO requests use same-origin reverse-proxy routes to Render. This lets browsers keep the HttpOnly session cookie even when third-party cookies are blocked. Production sockets use HTTP polling through the proxy; local development can upgrade to WebSockets. The backend health endpoint, browser login, session persistence after reload, authenticated AI table creation, and card dealing were verified against the live deployments on 2026-11-12. The temporary verification account was removed and no email was sent. Resend is configured, but actual mail delivery and Google OAuth consent were not exercised by this check.

Use `https://bluffx.vercel.app` for Render's `APP_ORIGIN` and `CLIENT_ORIGIN`, and add it to Google's authorized JavaScript origins.

## Render backend

Create a web service from this repository, or use its root `render.yaml` Blueprint. Settings:

- Root directory: `server`
- Runtime: Node.js 24.11.0
- Build: `npm ci --omit=dev`
- Start: `npm start`
- Health check: `/health`
- Instance: Free for initial testing (can sleep when idle)

Set these environment variables on Render, never in client code:

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `DATABASE_URL` | Neon pooled URL from ignored root `.env.local` |
| `DATABASE_URL_UNPOOLED` | Neon direct URL from that file |
| `APP_ORIGIN` | The final Vercel frontend origin, with no trailing slash |
| `CLIENT_ORIGIN` | The same frontend origin; comma-separated exact origins if needed |
| `SESSION_COOKIE_SAME_SITE` | `none` for separate Vercel/Render domains; `lax` for same-site custom domains |
| `GOOGLE_CLIENT_ID` | Existing Web application Google client ID |
| `MAIL_PROVIDER` | `resend` |
| `RESEND_API_KEY` | Resend sending API key |
| `MAIL_FROM` | Sender on your verified Resend domain |

Render provides `PORT`; do not set it to a localhost-specific value. A missing Resend key leaves email unavailable without preventing guest play or account login. Production cannot use `MAIL_PROVIDER=local`. Render's ephemeral filesystem is not used for account storage.

## Vercel frontend

Import the same repository into Vercel:

- Root directory: `client`
- Framework: Vite
- Install: `npm ci`
- Build: `npm run build`
- Output: `dist`
- Public environment variable: `VITE_SERVER_URL=https://bluffx.vercel.app`

The committed `client/vercel.json` supplies these build settings, authentication/Socket.IO proxy routes to Render, and SPA fallback. Keep the frontend URL as `VITE_SERVER_URL` so cookies are first-party; do not change it back to the Render origin. The exact Socket.IO endpoint and trailing-slash setting must match the proxy rules. `VITE_SERVER_URL` is baked into the client: redeploy after changing it. No database, mail, or OAuth client secret belongs on Vercel's client build.

Once Vercel assigns the frontend URL, update `APP_ORIGIN` and `CLIENT_ORIGIN` on Render and redeploy the backend. Keep that stable production URL for account emails and CORS; arbitrary preview domains are not automatically trusted.

Production cookies are Secure and HttpOnly. The same-origin proxy avoids reliance on third-party cookies. `SESSION_COOKIE_SAME_SITE=none` is currently supported; `lax` also works with the proxy if changed on Render. If bypassing the proxy to call a different site directly, third-party cookie restrictions apply again.

## Google and Resend

Add the final frontend origin under the existing Google Web OAuth client's **Authorized JavaScript origins**. No backend redirect URL is required for this app's Google popup flow.

Verify your owned sending domain's DNS records in Resend, set `MAIL_FROM` to an address on it, and add the API key on Render. For initial testing without a verified domain, `BluffX <onboarding@resend.dev>` is limited to your Resend account's own email address. Resend can also be tested from localhost; deployment is not required for its API.

## Verify the deployed app

1. The Render `/health` endpoint returns `{"ok":true}`.
2. The Vercel login page loads without API/CORS errors.
3. Create an account, reload, and confirm the session remains signed in.
4. Create an AI table and a two-browser multiplayer room; confirm identity and turns work.
5. Request verification and password-reset emails and confirm their links point to the Vercel frontend.
6. Sign in with Google after authorizing the frontend origin.

Run `npm --prefix server run check:deployment` to verify real deployed login, session restoration, and game creation with Chrome's third-party cookies explicitly blocked. This command creates a temporary verified account directly in the configured Neon database, sends no email, and removes its account and sessions afterward. It requires development dependencies installed in `client` and the deployed app's Neon credentials loaded locally.

Do not commit `.env` files, Neon links, mail previews, SQLite backups, or deployment credentials. `.gitignore` excludes these paths.

References: [Render Node deployment](https://render.com/docs/deploy-node-express-app), [Render Blueprint reference](https://render.com/docs/blueprint-spec), [Vercel project configuration](https://vercel.com/docs/project-configuration), [SameSite cookies](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie).
