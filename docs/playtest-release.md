# BluffX 0.2.0 closed playtest release

Production has not been deployed by this work. Keep initial playtests invite-only and unranked. The release includes durable game state, offline/AFK enforcement, TURN voice, host removal, feedback, account erasure, and private operator diagnostics.

## Verification

Local verification on 2026-11-13:

| Check | Result |
| --- | --- |
| `npm test` | 86 passed, 4 skipped; database cases run separately |
| `npm run test:e2e` | 25 passed on isolated ports 4020/5180 |
| `npm run test:postgres` | 18 passed against an isolated Neon branch, including migration 004, owner-connection failure, recovery, ranking limits and erasure |
| Production client/server dependency audits | Zero reported vulnerabilities |
| `npm run build` | Passed |
| `npm run test:turn` | Passed: selected candidate route used TURN; 40 decoded samples, zero silent samples |

`npm run test:turn` separately tests Cloudflare credential generation and real relay-only browser audio with synthetic microphone input. This cannot establish headset quality on physical devices or distant networks. Google consent, production Resend delivery, mobile voice, a backup/restore drill, and the new GitHub workflow still require release checks.

The repeatable `npm run test:load -- --rooms 20 --rounds 6` run used the in-memory persistence test double and a 128 MiB Node heap cap. It processed 360 actions across 120 rounds: average 21.70 ms, p95 34.38 ms, 360 commits, 960 delivered messages and 981,713 message bytes. The two-second idle window produced zero commits, messages or receipt lookups. RSS was 112.8 MiB and heap used 37.6 MiB; workload CPU was 578 ms and event-loop p95 32.47 ms. These are local synthetic measurements, not Neon round-trip latency or Render capacity guarantees. Historical performance measurements and their limitations are in [the performance report](beta2-performance.md).

## Required backend configuration

Preserve existing database, origin, Google and mail settings from [deployment](deployment.md). Add these on Render, never as public Vite variables:

```dotenv
NODE_VERSION=24
GAME_ADMISSIONS_OPEN=true
PLAYTEST_UNRANKED=true
PLAYTEST_INVITE_ONLY=true
PLAYTEST_ALLOWED_EMAILS=your-invited-addresses-separated-by-commas
RANKED_REQUIRE_VERIFIED=true
RANKED_PAIR_DAILY_LIMIT=3
GAME_MAX_ROOMS=20
GAME_POOL_SIZE=4
AUTH_POOL_SIZE=2
VOICE_TURN_PROVIDER=cloudflare
VOICE_RELAY_ONLY=false
```

Generate separate random secrets of at least 32 characters for `OPS_API_TOKEN` and `RATE_IDENTITY_SECRET`; both are required in production. Copy `CLOUDFLARE_TURN_KEY_ID` and `CLOUDFLARE_TURN_API_TOKEN` from the local private configuration into Render's secret environment settings. Local `.env` files are ignored and will not accompany a Git push. The Cloudflare API token stays on the backend; browsers receive only temporary ICE credentials. Use relay-only mode for diagnosis, not as an automatic permanent requirement. Check the provider's usage allowance and billing settings.

Invited users must sign in and verify their email to enter tables. Reconnecting an existing seat remains possible while admissions are closed. AI-assisted and casual outcomes do not award verified competitive wins. Ranked human matches require verified accounts; the same winner/opponent pair can contribute at most three ranked results per UTC day. Remaining matches still finish normally as unranked results. Local browser records never become official scores.

## Safe deployment and rollback

1. Review the exact source revision and CI results before deployment. Push can trigger automatic hosting deployments, so obtain the release approval before pushing. Configure the new required secrets first.
2. Schedule a maintenance handoff. Set `GAME_ADMISSIONS_OPEN=false` on the existing compatible backend and allow matches to finish. The currently deployed older release may not support this gate or the new durable format; do not assume it can recover new matches.
3. Review all migrations and the target database identity. Run `npm run db:migrate-games` only with the intended production database environment, during maintenance. Migration `004_launch_controls.sql` adds erasure requests, reports, ranking pair counters and the deletion marker; it does not reset existing accounts. The migration runner checks earlier migration checksums. Never reset Neon or edit an already applied migration.
4. Stop the old backend owner before starting the new owner. The advisory lock and fencing intentionally permit one authoritative process. Render overlapping deployments are not a zero-downtime handoff; the new process may wait for ownership. Recover saved deadlines rather than granting fresh time.
5. Deploy the backend, verify health/version/build and recovery logs, then deploy the frontend from the same reviewed revision. Keep `VITE_SERVER_URL` set to the frontend origin to preserve the existing auth/socket proxy.
6. Run `npm --prefix server run check:deployment` for read-only health/proxy checks. Then manually test invited account login, Google sign-in, verification/reset mail, private/public table creation, reconnection and one complete match. Keep the playtest unranked.
7. Reopen admissions only after the checks. Do not advertise voice as verified until the physical-device checks below pass.

Rollback must use a schema-compatible build that understands saved state. Do not roll back to beta.1 during an active new-format match. Prefer finishing matches or fixing forward; keep Neon data intact. A point-in-time restore changes player data and requires an explicit maintenance decision. No production restore or destructive schema downgrade was performed or automated.

## Operator checks and retention

With the backend URL and operator secret set privately, use:

```text
node server/scripts/ops.js metrics
node server/scripts/ops.js reports
```

These call authenticated `/auth/ops/metrics` and `/auth/ops/reports`. The public development debug route stays disabled in production. Production metrics are sampled once per minute; there is no one-second database timer loop. Reports retain only bounded, sanitized diagnostic fields, not hands or voice recordings. Reports expire after 30 days; completed in-memory rooms are removed after five minutes. Account erasure revokes sessions and queues durable anonymization of game references. Pending erasures are retried on startup and cleanup.

Host removal preserves cards and turn invariants and blocks the removed account/resume identity from that room. A guest can evade identity bans by creating a fresh identity; verified invite-only accounts are the protection for closed testing. Browser identity cookies supplement coarse IP limits so shared proxy addresses do not collapse all users into one low limit.

## Playtest checklist

- Use four to six invited people across desktop/mobile and at least two networks. Exercise public and private rooms, clockwise seats, challenges, final-card claims, round results, rematches and host removal.
- Miss three eligible turns, inspect both warnings and AI takeover, then use Take Control. Disconnect during warnings and AI play; verify no renewed grace or AI allowance. Check removal after three completed claim/reveal rounds, including the two-player victory case.
- With headsets on two separate physical devices, talk both ways for ten minutes, mute/unmute, leave/rejoin voice, switch tabs and change networks. Inspect the voice details and use Copy report if audio cuts. Testing normal/incognito on one computer is useful automation, but shares audio hardware and is not physical-device signoff.
- Rehearse a restart on a staging database during a turn, result countdown and AI takeover. Check original hands, deadlines, seat recovery and single finalization.
- Submit feedback, inspect private reports, and test email-confirmed deletion with dedicated test accounts. Do not use real account deletion as a read-only production check.
- Record build, browser/device, approximate time and reproduction steps for every issue. Never put credentials or hidden hands in bug reports.

There are no new paid infrastructure dependencies beyond the user-selected TURN provider. Render Free sleep/cold-start and network/Neon region latency remain operational limits; no keep-alive traffic was added.
