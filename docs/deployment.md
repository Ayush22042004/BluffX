# Deploy BluffX on Render and Vercel

Custom avatars require additive migration `003_player_avatars.sql` before starting the updated backend. See [avatars and clockwise seating](avatars-and-seating.md) for storage limits, verification, and release instructions.

Table Voice uses the existing Socket.IO proxy for signaling and WebRTC for audio. See [voice connectivity and optional TURN configuration](voice-chat.md) before testing players on different networks. No additional database migration is required for voice.

The GitHub repository is https://github.com/Ayush22042004/BluffX. Accounts and durable game snapshots/results use Neon PostgreSQL. Keep a single backend instance; a direct PostgreSQL ownership lock rejects additional owners. Before deploying this reliability release, follow the [migration and maintenance handoff procedure](reliability-overhaul.md#release-procedure-and-limitations). Stop the old backend before starting its replacement. The new code and database migrations have not been deployed automatically.

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
| `GAME_AUTO_MIGRATE` | `false`; run the reviewed `npm run db:migrate-games` explicitly before starting |
| `APP_ORIGIN` | The final Vercel frontend origin, with no trailing slash |
| `CLIENT_ORIGIN` | The same frontend origin; comma-separated exact origins if needed |
| `SESSION_COOKIE_SAME_SITE` | `none` for separate Vercel/Render domains; `lax` for same-site custom domains |
| `GOOGLE_CLIENT_ID` | Existing Web application Google client ID |
| `MAIL_PROVIDER` | `gmail` for the configured existing Gmail mailbox |
| `GMAIL_CLIENT_ID` | Private sender Desktop OAuth client ID, separate from player sign-in |
| `GMAIL_CLIENT_SECRET` | Private sender OAuth client secret |
| `GMAIL_USER` | Authorized sending Gmail address |
| `GMAIL_REFRESH_TOKEN` | Owner-authorized refresh token; production cannot read your local token file |
| `MAIL_FROM` | `BluffX <your-authorized-gmail-address>` |
| `REPORTS_TO` | Private support report inbox |
| `OPS_API_TOKEN` | At least 32 random characters for private operator access |
| `RATE_IDENTITY_SECRET` | At least 32 random characters, kept stable across deployments |

Render provides `PORT`; do not set it to a localhost-specific value. Follow [Gmail setup](gmail.md) for owner authorization and token lifetime requirements. Missing mail credentials leave delivery unavailable without preventing guest play or account login. Production cannot use `MAIL_PROVIDER=local`. Render's ephemeral filesystem is not used for account storage.

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

## Google sign-in and email

Add the final frontend origin under the existing Google Web OAuth client's **Authorized JavaScript origins**. No backend redirect URL is required for this app's Google popup flow.

The configured sender uses [Gmail API over HTTPS](gmail.md), which does not require a custom sending domain. Its private OAuth sender credentials are separate from player Google sign-in. Existing [Resend](resend.md) and [Brevo](brevo.md) adapters remain alternatives if you later verify a domain; do not enable multiple providers implicitly during a release.

## Verify the deployed app

1. The Render `/health` endpoint returns `{"ok":true}`.
2. The Vercel login page loads without API/CORS errors.
3. Create an account, reload, and confirm the session remains signed in.
4. Create an AI table and a two-browser multiplayer room; confirm identity and turns work.
5. Request verification and password-reset emails and confirm their links point to the Vercel frontend.
6. Sign in with Google after authorizing the frontend origin.

Run `npm --prefix server run check:deployment` for read-only production health, frontend and proxy checks. It creates no account, session or match. The former account-creating check is available only with `DEPLOYMENT_CHECK_MODE=isolated`, an explicit local `DEPLOYMENT_FRONTEND_URL`, and the isolated `TEST_DATABASE_URL` / `TEST_DATABASE_HOST` guard. Full login, AFK, reconnect and gameplay checks run through `npm run test:e2e` on 4020/5180. See [beta.2 performance and deployment notes](beta2-performance.md).

Default connection caps are `GAME_POOL_SIZE=4`, `AUTH_POOL_SIZE=2`, plus one direct owner connection. Public debug metrics are disabled in production; production diagnostics use sampled logs and the authenticated operator endpoint. `GAME_FINISHED_MEMORY_MS=300000` closes completed tables after five minutes, retaining official results in Neon. Existing active schema-1 snapshots normalize controller state without redealing or resetting deadlines. The current release requires migrations 001–006, including avatar storage, launch controls, social features and the private report email queue. See [Resend setup](resend.md) before enabling support notifications. See the [closed playtest release runbook](playtest-release.md) for required operator secrets, invitations, TURN settings, maintenance handoff and rollback limits.

Do not commit `.env` files, Neon links, mail previews, SQLite backups, or deployment credentials. `.gitignore` excludes these paths.

References: [Render Node deployment](https://render.com/docs/deploy-node-express-app), [Render Blueprint reference](https://render.com/docs/blueprint-spec), [Vercel project configuration](https://vercel.com/docs/project-configuration), [SameSite cookies](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie).
