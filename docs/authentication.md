# Authentication setup

BluffX includes email/password accounts, Google sign-in, verification and reset emails, durable player profiles, and guest play. The login page appears before the game. Guests can return to login from **My Profile**.

## Run locally

Use Node.js 24.11 or later. From the repository root:

```powershell
npm install
npm --prefix server install
npm --prefix client install
Copy-Item server/.env.example server/.env
# Run neon deploy at the root, or configure PostgreSQL as described below.
npm run dev
```

If `server/.env` already exists, edit it instead of overwriting it. Open `http://localhost:5173`.

Email/password signup and login work once PostgreSQL is configured. Until Resend or SMTP is configured, development writes verification and reset messages to private JSON files in `server/.data/mail`. Open the newest matching message locally and visit the URL in its `text` field. These files are never served by the app and contain sensitive, short-lived links. Do not publish or commit them.

The login page identifies local email delivery. Google sign-in remains disabled until a client ID is supplied. No Google credentials are simulated.

## Google sign-in

1. Create or select a project in [Google Cloud Console](https://console.cloud.google.com/).
2. Configure Google Auth Platform branding, audience, and consent. Add test users if the app is in testing mode.
3. Create an **OAuth client ID** of type **Web application**.
4. Add `http://localhost:5173` as an **Authorized JavaScript origin**. Add each deployed frontend origin separately when publishing. Include `http://localhost:4173` if using Vite preview.
5. Put the client ID in `server/.env`:

```dotenv
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
```

6. Restart the server and refresh the page. The official Google sign-in button will replace the disabled placeholder.

**Important:** edit `server/.env`, not `server/.env.example`. The `.example` file is only a template. If the Google button is disabled after adding an ID, confirm that `server/.env` exists, then restart the server. Changing environment files does not automatically reload a running server. Hosting/process variables take precedence, followed by root `.env.local`, root `.env`, then `server/.env`. Neon database URLs can stay in the root file that `neon deploy` generates; Google and mail settings can stay in `server/.env`.


This integration uses the Google Identity Services popup to obtain an ID token. The server verifies the token signature, audience, issuer, and expiry with Google's library. A client secret and an application redirect endpoint are not needed for this flow. Existing email/password accounts are not silently linked to a Google identity sharing their email address; use email sign-in for that account.

Reference: [Google backend token verification](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token), [Google button setup](https://developers.google.com/identity/gsi/web/guides/display-button).

### If Google says the origin is not allowed

Edit the **same Web application OAuth client** whose ID is in `server/.env`. Under **Authorized JavaScript origins**, add both `http://localhost` and `http://localhost:5173` (the frontend origin, not the backend at port 4000). Save, allow time for Google's settings to propagate, and reload the page. Add any other frontend origin you actually use separately, such as `http://127.0.0.1:5173` or `http://localhost:4173`. Redirect URI entries do not replace authorized JavaScript origins for this popup flow.

## Email delivery

### Render: use Resend over HTTPS

Render free web services block outbound SMTP ports 25, 465, and 587. The backend supports the Resend HTTPS API, so verification and password-reset emails do not need SMTP connections.

1. Create a [Resend account](https://resend.com/) and an API key with sending access.
2. Add and verify a sending domain in Resend, including the DNS records it supplies. Use an address on that domain for `MAIL_FROM`. A provider's test sender is for testing, not general public delivery.
3. In **Render ? backend service ? Environment**, add:

```dotenv
NODE_ENV=production
MAIL_PROVIDER=resend
RESEND_API_KEY=re_your_private_api_key
MAIL_FROM=BluffX <no-reply@your-verified-domain.example>
APP_ORIGIN=https://your-frontend.example
CLIENT_ORIGIN=https://your-frontend.example
```

4. Save and redeploy. `APP_ORIGIN` must be the actual frontend URL; verification and reset links point there. `CLIENT_ORIGIN` controls which frontend can send authenticated requests.
5. Create an account and request a verification or reset email. Confirm it appears in Resend's email logs and is delivered to the inbox.

The API key stays on the backend. Do not put it in a `VITE_` variable, commit it, or paste it into the client. SMTP variables are not needed with `MAIL_PROVIDER=resend`.

Resend requests use HTTPS, a timeout, and an idempotency key. Failed provider responses are reported without exposing provider payloads or credentials. No real Resend message is sent by automated tests; the request and failure cases use an injected HTTP client.

References: [Render free-service restrictions](https://render.com/docs/free), [Resend Send Email API](https://resend.com/docs/api-reference/emails/send-email).

### Provider selection and local development

`MAIL_PROVIDER=auto` is the default. It prefers `RESEND_API_KEY`, then `SMTP_HOST`. If neither is configured, development writes private previews to `server/.data/mail`, while production reports email delivery as unavailable. Explicit `MAIL_PROVIDER=resend` requires both `RESEND_API_KEY` and `MAIL_FROM`; missing settings never silently fall back to a local outbox. Local-preview mode is rejected in production.

### Optional SMTP alternative

For hosts that permit SMTP, configure:

```dotenv
MAIL_PROVIDER=smtp
SMTP_HOST=smtp.your-provider.example
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-smtp-username
SMTP_PASS=your-smtp-password
MAIL_FROM=BluffX <no-reply@your-verified-domain.example>
APP_ORIGIN=http://localhost:5173
```

For implicit TLS on port 465, set `SMTP_PORT=465` and `SMTP_SECURE=true`. On port 587, Nodemailer upgrades with STARTTLS when supported. Restart the server after changing local configuration. Keep credentials in `server/.env` or your deployment's secret manager.

Reference: [Nodemailer SMTP configuration](https://nodemailer.com/smtp).

### Verification and reset behavior

Signup sends a verification link valid for 24 hours. **Forgot password?** sends a one-time link valid for 30 minutes. Resetting a password invalidates existing sessions. Unverified accounts may play; **My Profile** shows verification status and allows resending the message.

If delivery fails during signup, the account is still created. The profile's resend action reports delivery errors. Failed delivery does not invalidate an earlier verification/reset link. Reset requests intentionally give the same response for registered and unregistered addresses.

## Deployment and storage

- Set `NODE_ENV=production`, `APP_ORIGIN=https://your-frontend.example`, and `CLIENT_ORIGIN=https://your-frontend.example`.
- Use HTTPS. Production cookies are Secure and HttpOnly. Set `SESSION_COOKIE_SAME_SITE=none` for separate Vercel/Render domains; use `lax` for same-site custom domains. Browsers that block third-party cookies may still require same-site custom domains or a reverse proxy. See [deployment.md](deployment.md).
- For the deployed Vercel proxy, set `VITE_SERVER_URL=https://bluffx.vercel.app` so API and game requests stay on the frontend origin. Keep the auth and Socket.IO proxy rules in `client/vercel.json`; see [deployment.md](deployment.md).
- Set `DATABASE_URL` to persistent PostgreSQL storage. Accounts, password hashes, verification/reset tokens, sessions, profiles, and tutorial preferences live there.
- Keep one backend instance for now: active game rooms and timers remain in memory and end on restart. Multiple instances also need shared room state and socket coordination.
- Production does not fall back to the local email outbox when no mail provider is configured.
- Account names and avatars are saved in PostgreSQL. Guest profiles and match counters remain browser-local; this change does not add cloud game-stat sync.
- Logging out ends that browser session. Password resets revoke all sessions. Signed-in room identity comes from the authenticated server profile, not client-supplied names.

### PostgreSQL setup: local now, Render later

This workspace is configured for Neon project `twilight-truth-53846390`, branch `production`, organization `org-bold-night-75241816`. `neon.ts` manages the PostgreSQL-only setup; the Express backend retains account authentication, Resend integration, and Socket.IO. The existing `pg` connection pool fits the long-running Node runtime on Render.

From the project root:

```powershell
neon login
neon deploy
```

Deployment pulls the pooled `DATABASE_URL` and direct `DATABASE_URL_UNPOOLED` into root `.env.local` (or `.env` if it exists). Both files are ignored by source control. The backend and SQLite importer load them automatically. App requests use the pooled URL; startup schema setup and imports use the direct URL when supplied. Do not copy either credential into client code or a `VITE_` variable.

For a manual connection instead:

1. Create a PostgreSQL project at [Neon](https://console.neon.tech/). In **Connect**, copy the database connection string. Keep its TLS parameters intact. Use the direct connection for initial schema creation/import; a pooled endpoint can serve normal app traffic.
2. Add it to **server/.env** alongside the existing Google and Resend settings:

```dotenv
DATABASE_URL=postgresql://USER:PASSWORD@HOST/DATABASE?sslmode=require
```

3. Run `npm --prefix server install`. To retain existing local accounts, stop the backend and import them **before restarting it**:

```powershell
npm --prefix server run db:migrate-sqlite
# Optional alternate source:
# npm --prefix server run db:migrate-sqlite -- E:/backups/accounts.sqlite
# To add non-conflicting SQLite data to an existing PostgreSQL database:
# npm --prefix server run db:migrate-sqlite -- --merge
```

The importer initializes tables and copies account IDs, password hashes, Google identities, profiles, tutorial preferences, sessions, and email tokens in one transaction. By default it requires an empty destination. With `--merge`, it preserves existing PostgreSQL rows, skips identical previously imported rows, and aborts the transaction if any identity or stored data conflicts; it never overwrites an existing account. SQLite stays unchanged. Do not import while the app receives traffic. Back up the SQLite file and retain it until you have checked the imported accounts. To start with fresh accounts, skip the import.

4. Run `npm run dev`. Tables and indexes are created before the server accepts requests. Missing `DATABASE_URL` or a failed connection prevents startup; there is no temporary-storage fallback. Local development also uses PostgreSQL. A locally installed database can use `postgresql://postgres:PASSWORD@localhost:5432/bluffx` without cloud TLS parameters.
5. On Render, add `DATABASE_URL` and `DATABASE_URL_UNPOOLED` to the **backend environment**. Render does not receive the ignored local environment file. Use a separate development branch/database if local test accounts should not appear in production. Never put these secrets in a `VITE_` variable or commit them.

Accounts survive backend restarts and deployments because the database is hosted separately. Retention and backups still depend on the provider plan. **Render free PostgreSQL databases expire after 30 days**, so choose a suitable managed database plan for lasting storage and keep backups.

Render setup for the backend: **Root Directory** `server`, **Build Command** `npm ci`, **Start Command** `npm start`, **Health Check Path** `/health`. Render supplies `PORT`; do not force it to localhost's port. Keep the frontend/API same-site or use a reverse proxy, as described above, so cookie authentication works.

References: [Neon connections](https://neon.com/docs/connect/connect-from-any-app), [node-postgres TLS](https://node-postgres.com/features/ssl), [Render free database limits](https://render.com/docs/free).

## Validation

```powershell
npm test
npm run build
npm run test:e2e
# Real configured database: signup, verification, profile, restart persistence,
# authenticated Socket.IO, password reset, login/logout; removes its own account.
npm --prefix server run check:neon
# Browser tests against real PostgreSQL instead of the test-only emulator:
$env:BLUFFX_TEST_DATABASE='neon'
npm run test:e2e
Remove-Item Env:BLUFFX_TEST_DATABASE
```

Server checks use a test-only PostgreSQL emulator and cover sessions surviving auth service reinitialization, hashing, Google verification through an injected verifier, email link expiry/reuse, password resets, profile validation, request origins, and game regressions. Browser checks cover signup, verification, reset, sign-in/out, saved profiles, guest entry, mobile layout, and live play. The emulator does not verify real PostgreSQL locking, network/TLS behavior, or disk durability. `check:neon` exercises the real configured database and a real backend process restart, uses local email previews, and deletes only its own unique test account. Browser tests use real PostgreSQL when `BLUFFX_TEST_DATABASE=neon`; reserve test ports 4020 and 5180 for Playwright, which launches its own backend and frontend. Browser-created test accounts remain in that database. Real Google consent and email delivery require configured credentials; automated tests do not contact those providers.

## First-login tutorial

New accounts are offered a guided practice game. Choosing **Skip for now** or **Finish Tutorial** saves the preference on the account. Existing databases gain the tutorial preference column automatically on server startup; no manual migration is required. Accounts without a saved preference receive the invitation once. Players can replay the lesson from **How to Play** without affecting match stats.
