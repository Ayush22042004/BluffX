# BluffX development audit — 2026-11-13

Scope: current local v0.3.0 worktree, including themes, settings and report notifications. Review and suggestions only: no gameplay fixes, production migrations, deployment, real email delivery or paid services. SMTP/Resend troubleshooting is deferred at the user's request.

## Release assessment

Suitable for continued local development; do not certify the current worktree as ready for unrestricted playtesting until the blocking overlay defects below are resolved. Core integrity checks are substantially stronger than the outstanding UI issues. The live read-only backend still reports `0.2.0-beta.1`, so local findings must not be represented as deployed behavior.

## Findings, in recommended order

### 1. Fix tutorial overlay stacking before new-user playtests

Both desktop onboarding and mobile How to Play tutorial flows timed out when attempting card inspection. `TutorialGame.jsx` portals `.tutorial-inspection` to `document.body`; its effective z-index is 100, while `.modal-backdrop` is 200. The parent tutorial overlay covers the inspection dialog. Use a shared layer scale with nested evidence above its parent and scope keyboard focus to the active topmost dialog. Retest both complete tutorials without forced clicks.

### 2. Make fullscreen guidance non-obstructive

The final-win/rematch browser flow reached the correct winner screen but could not click Rematch: the Playwright log explicitly identifies `.fullscreen-tip` intercepting pointer events. This is an input-obstruction problem, not evidence that result finalization is broken. Move guidance into reserved space, dismiss it when entering active play/results, or allow pointer events only on its dismissal control. Preserve the user's requested per-visit/per-refresh recommendation.

### 3. Keep mutations pending until authoritative acknowledgement

The Table settings submit handler calls `emit("update_settings", ...)` and closes the dialog immediately. If storage fails, the user loses the draft and only receives a later toast. Await success, disable repeated Save while pending, preserve edits on rejection and close only on confirmation. Audit ready/rematch/leave controls for the same pending/error treatment without weakening server validation.

### 4. Measure and improve the actual production transport

First investigate persistence/network latency: the separate small real-Neon sample below had 775 ms mean acknowledgement / 1.90 s p95 with matching persistence timings and little CPU work. This does not prove Render-to-Neon production latency, but it is stronger evidence of IO waiting than of a CPU bottleneck on the tested path. Compare Render and Neon regions, sampled hosted commit latency and transaction round trips before changing hosting resources or removing durability. Keep the existing small pools, committed-before-ack rule and isolated load checks.

`client/src/lib/socket.js` sets `upgrade: !import.meta.env.PROD`, so the normal production connection stays on HTTP polling even though WebSocket is listed. `client/vercel.json` proxies the Socket.IO endpoint. Stage an authenticated WebSocket path and measure acknowledgement p50/p95, request count and reconnect behavior; retain tested polling fallback. Do not simply enable upgrades without verifying routing/cookies. Current [Vercel rewrite documentation](https://vercel.com/docs/routing/rewrites) and hosting capabilities must be checked against the selected deployment path.

### 5. Complete real-device voice qualification

The local synthetic voice regression passed 40 playback samples with zero silent samples. That does not validate speech with physical headsets, Bluetooth, iOS/Android backgrounding or separate networks. Run 2-, 4- and 10-player sessions on Wi-Fi plus mobile data, including mic changes, refresh, mute/deafen and returning from background. Mesh sends to up to nine peers per ten-player seat; assess bandwidth/device limits before considering an SFU. Review provider usage alerts and [Cloudflare Realtime pricing](https://developers.cloudflare.com/realtime/sfu/platform/pricing/) before any relay-scale test. No relay spending or configuration changed in this audit.

### 6. Reduce first-load artwork and stylesheet cost

`lounge.png` is 2,131,089 bytes and `portraits.png` is 2,442,576 bytes, about 4.6 MB combined. Generate visually compared WebP/AVIF derivatives with mobile-appropriate dimensions; preserve original source artwork. Audit actual network transfer and caching on slow mobile connections. The current CSS build is 198.72 kB / 44.23 kB gzip, and JavaScript 309.57 kB / 97.33 kB gzip. These are build sizes, not measured user download or runtime memory.

The stylesheet has 8,517 lines and `App.jsx` 2,240 lines. Consolidate repeated selectors/theme compatibility declarations, split major screens and dialogs, and lazy-load nonessential tutorial/social/history UI when justified by a bundle measurement. Avoid a full rewrite or speculative memoization.

### 7. Apply keyboard/dialog behavior consistently

Focus capture, Tab wrapping, Escape dismissal and focus restoration currently apply to social/records drawers only. Extend a shared dialog primitive to settings, preferences, help, profile, results interactions and nested tutorial evidence. Verify screen-reader labels, selected cards, announcements and color contrast in every theme. Responsive collision tests are not a full accessibility audit.

### 8. Add and test explicit response security headers

No application-defined CSP, frame policy or referrer policy is configured in `client/vercel.json` or server middleware. Read-only live sampling confirmed the frontend lacks CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy and Permissions-Policy; it does have platform-provided HSTS. The sampled backend health response lacks those headers. Add a compatible policy, initially report-only for CSP. Account for Google sign-in, Google Fonts, Socket.IO and WebRTC; never ship an untested restrictive policy that breaks login or voice. Add automated header checks and remove unnecessary framework disclosure where appropriate.

### 9. Harden failure reporting and operational visibility

The deadline scheduler swallows task rejections and hourly retention catches errors silently. Preserve safe retries, but record sampled failure codes/counters and alert on repeated storage failures, scheduler failures and recovery loops. Existing diagnostics already expose bounded latency, memory and event-loop measurements; use those before increasing resource limits. A public generic health success alone cannot certify successful gameplay or voice.

### 10. Make deployment configuration harder to misconfigure

Both auth and socket modules fall back to `http://localhost:4000` if `VITE_SERVER_URL` is absent, even in a production build. Prefer an explicit production build check or a documented same-origin production default while retaining localhost development. Test a fresh clone/build with only documented environment variables. Keep same-origin authentication and account/seat authorization intact.

Local changes are still uncommitted, and the hosted revision is older. Prepare a reviewable release commit, run hosted CI, inventory pending migrations read-only, rehearse the single-owner maintenance handoff, and test a backup restore in an isolated database before production. Do not run two authoritative processes against the same match store. Review existing report migration 006 alongside earlier pending updates; this audit does not apply them.

### 11. Add measured playtest controls rather than more features first

Use a small invite-only unranked group and the existing room limit. Track action acknowledgement latency, disconnect reason, recovery time, persistence p95, event-loop delay and failed actions with safe report references. Include public/private joins, final claim/challenge/pass, AFK, simultaneous disconnects, return from AI, host departure, auto-next-round and ready-confirmed rematch. Do not infer fairness from UI polish or synthetic load alone.

Render Free can sleep after 15 minutes idle and takes about a minute to wake according to [Render's documentation](https://render.com/docs/free). The application has retries/loading states, but code cannot guarantee an always-awake free instance. Measure an actual hosted cold start; avoid fake keep-alive traffic or promising production uptime from local tests.

### 12. Development tooling follow-up

CI already checks dependencies, migrations, tests and build. No lint/type-check script is defined. Introduce a staged ESLint configuration and JS checking/JSDoc for protocol/state boundaries rather than converting the entire project at once. Add browser artifact retention on failure, explicit overlay regression assertions and a build-to-hosted-version smoke check. Keep large voice/load experiments opt-in so ordinary CI remains bounded.

## Checks completed

| Check | Result |
| --- | --- |
| `npm test` | 97 passed, 6 opt-in suites skipped, 0 failed; 103 total |
| `npm run test:postgres` | 29 passed, 0 failed on the guarded isolated database |
| Full `npm run test:e2e` | 32 passed, 3 failed, 1 optional large-voice sample skipped; 36 total |
| `npm run build` | Passed |
| `npm run check:release` | Passed, migrations 001–006 source/checksum checks |
| Production dependency audits, root/server/client | Zero known vulnerabilities reported |
| Read-only deployment check | Backend health, frontend and auth proxy passed; live backend beta.1 |
| Synthetic local voice | 40 playback samples, 0 silent samples |

PostgreSQL checks include real restart recovery, concurrency/fencing, lost acknowledgements, transactional outage rollback, statistics finalization, social privacy and report outbox tests. No production data was modified. Browser failures are preserved rather than hidden by retries or relaxed assertions.

Focused reproduction: rerunning the rematch plus both tutorial tests with tracing yielded one pass (rematch) and two failures (both tutorials). Logs show the tutorial content intercepting clicks intended for the evidence dialog. The fullscreen/Rematch obstruction is timing-dependent; the full-run failure directly records the interception, while the focused pass does not negate it.

Local load sample: `npm run test:load -- --rooms 20 --rounds 6 --output docs/performance/audit-2026-11-13-local.json` completed 360 actions / 120 rounds in 20 rooms. Mean acknowledgement 12.91 ms, p95 17.23 ms, workload CPU 359 ms, sampled RSS 111.9 MiB, used heap 27.4 MiB, event-loop p95 32.13 ms. The two-second idle window had zero state commits, receipt lookups or application notifications. The workload emitted 960 application notifications and 980,215 payload bytes. Raw [local load evidence](performance/audit-2026-11-13-local.json).

These figures use the in-memory durability test double, with rate limits disabled for loopback clients. RSS/CPU include clients in the same process; application counts exclude Engine.IO heartbeats, HTTP polling overhead and voice media. They are not Render or real Neon latency/capacity certification, and a two-second idle sample does not exclude hourly maintenance or minute-level diagnostics.

Separate real-Neon sample: `npm run test:load -- --postgres --rooms 3 --rounds 2 --output docs/performance/audit-2026-11-13-neon.json` used the guarded isolated branch. Eighteen actions / six rounds averaged 775.29 ms acknowledgement, p95 1,900.75 ms. Persistence averaged 780.85 ms across 35 transitions, p95 1,897.22 ms. Workload CPU was 63 ms over 5,136.83 ms wall time; total sampled RSS 75.5 MiB, heap 18.9 MiB. Workload SQL calls 54 (three per action / nine per completed round); the two-second idle window had zero SQL calls, commits, receipt lookups or application notifications. The sample is small and runs from the development machine, not Render. It is not a direct like-for-like comparison to the larger memory workload or a capacity limit. Raw [isolated Neon evidence](performance/audit-2026-11-13-neon.json).

## Boundaries

This is source review plus executed regression checks, not a penetration test, full screen-reader audit, hosted capacity certification or physical voice sign-off. Production Google sign-in, real mail delivery, real TURN media quality and restore/rollback operations were not exercised. No app fixes were implemented during the audit.
