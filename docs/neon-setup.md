# Neon setup and verification

Verified on 2026-11-12 against project `twilight-truth-53846390`, production branch `br-muddy-tree-be835ik0`, organization `org-bold-night-75241816`.

The CLI is installed globally (`neon` 9.4.0). Initialization installed Neon's agent plugin and skills, created `neon.ts`, and wrote the ignored `.neon` project link. `neon deploy` confirmed the PostgreSQL-only policy and pulled the pooled and direct database URLs into ignored root `.env.local`. No credentials belong in this document or the browser bundle.

The app keeps its Express/Socket.IO backend and existing email/password and Google authentication. `pg` reuses a connection pool for this long-running Node runtime. Normal queries use `DATABASE_URL`; schema setup and SQLite imports use `DATABASE_URL_UNPOOLED` when available. The backend loads root `.env.local`, root `.env`, and `server/.env` in that order, with hosting/process variables taking precedence.

## Commands and results

```text
neon deploy
No changes — branch production already matches the policy.
Utilized services: Postgres
Pulled 5 Neon variables into .env.local

npm run build
✓ 56 modules transformed.
✓ built in 1.87s

npm test
tests 28
pass 28
fail 0

npm --prefix server run check:neon
PASS real Neon PostgreSQL connection
PASS backend startup and /health with real PostgreSQL
PASS signup, persisted password hash, profile, tutorial and email verification
PASS account, session and profile survive a backend process restart
PASS authenticated Socket.IO uses the PostgreSQL account identity
PASS password reset, session revocation, login and logout
PASS temporary test account and related sessions/tokens removed

$env:BLUFFX_TEST_DATABASE='neon'; npm run test:e2e
8 passed (49.0s)

neon config plan
No changes — branch production already matches the policy.
Utilized services: Postgres
```

The acceptance check starts real backend processes, performs real database writes, restarts the backend, then verifies the same cookie still restores the persisted profile. It uses private local email previews and removes its unique test account. Browser tests also ran against real Neon PostgreSQL, covering signup, verification, password reset, saved profiles, tutorials, mobile layouts, and live gameplay. Browser tests leave their example test accounts in the configured database.

The initial CLI browser sign-in timed out. After the user completed sign-in, deployment and database/browser verification succeeded. Initialization reported two critical root-package dependency advisories; `npm audit fix` resolved them, with the root audit reporting zero vulnerabilities. This is not a claim about a complete security audit of every package. Build and database runs printed non-fatal Browserslist/driver notices.

## Hosting and existing data

The database is live on Neon. The frontend and backend have not been deployed to Vercel/Render by this setup. On Render, configure both database URL variables in the backend environment, plus the existing Google/Resend/origin variables. Ignored local environment files are not sent to Render. Set `VITE_SERVER_URL` to the backend URL in Vercel and satisfy the cookie same-site/proxy requirements in [authentication.md](authentication.md).

On 2026-11-12, all existing SQLite account data was transferred into production using the importer's `--merge` mode. It added 16 accounts and 16 sessions, including password hashes, Google identities, profile names/avatars, verification state and tutorial preferences. SQLite had no email tokens to transfer. The 2 existing Neon accounts, 2 sessions and 1 email token were preserved, leaving 18 accounts, 18 sessions and 1 token immediately after the transfer. Every imported field and every existing Neon row was compared and verified unchanged.

The transfer was first tested on a temporary copy of the production Neon branch, including an idempotency check that a second import adds no duplicates. The original SQLite files remain unchanged, with a consistent WAL-aware backup at ignored `server/.data/backups/accounts-before-neon-transfer-20261112.sqlite`. `--merge` aborts instead of overwriting conflicting data. Keep the backup private because it contains credential hashes and session/token data.

Active game rooms remain in backend memory and end on restart; account/session persistence is independently verified. Browser-local guest profiles and match counters are not stored in SQLite and were not part of this database transfer.

Guidance followed: the installed `neon` and `neon-postgres` agent skills; [Neon connection methods](https://neon.com/docs/connect/choose-connection), [Neon connection pooling](https://neon.com/docs/connect/connection-pooling), and [node-postgres transactions](https://node-postgres.com/features/transactions).
