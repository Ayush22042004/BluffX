# Deploy BluffX on Render and Vercel

The GitHub repository is https://github.com/Ayush22042004/BluffX. Account data is already in Neon PostgreSQL. Keep a single backend instance: live rooms and turn timers are in memory.

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
- Public environment variable: `VITE_SERVER_URL=https://YOUR-BACKEND.onrender.com`

The committed `client/vercel.json` supplies these build settings and SPA fallback. `VITE_SERVER_URL` is baked into the client: redeploy after changing it. No database, mail, or OAuth client secret belongs on Vercel's client build.

Once Vercel assigns the frontend URL, update `APP_ORIGIN` and `CLIENT_ORIGIN` on Render and redeploy the backend. Keep that stable production URL for account emails and CORS; arbitrary preview domains are not automatically trusted.

Production cookies are Secure and HttpOnly. `SameSite=None` permits cross-site cookies, but browsers that block third-party cookies can still prevent login persistence between `vercel.app` and `onrender.com`. Same-site custom domains such as `app.yourdomain.com` and `api.yourdomain.com` avoid that restriction; use `SESSION_COOKIE_SAME_SITE=lax` with them.

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

Do not commit `.env` files, Neon links, mail previews, SQLite backups, or deployment credentials. `.gitignore` excludes these paths.

References: [Render Node deployment](https://render.com/docs/deploy-node-express-app), [Render Blueprint reference](https://render.com/docs/blueprint-spec), [Vercel project configuration](https://vercel.com/docs/project-configuration), [SameSite cookies](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie).
