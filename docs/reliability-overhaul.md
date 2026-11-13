# Multiplayer reliability implementation

This is the beta.1 durability report. For subsequent controller, scheduler, transport, connection-budget and completed-table-retention changes, use the [beta.2 implementation/performance report](beta2-performance.md).

This release keeps the existing game engine, Socket.IO protocol transport, authentication, PostgreSQL driver, Vercel proxy, and visual design. It replaces in-memory-only orchestration and browser-owned competitive results. No production deployment or production migration was performed for this change.

## Persistence and recovery

`RoomService` serializes transitions per room, clones the current state, validates the action, and submits a version-checked transaction. Only a successful commit installs that clone, broadcasts it, and acknowledges success. The snapshot, action receipt, match finalization, participant results, and statistics update share one transaction. A failed or ambiguous commit triggers a database resynchronization; clients cannot continue against the uncommitted clone.

Snapshots contain the complete private state: immutable seats/account identities, dealt hands, remaining pile/discard, claims, action sequences, round and match scores, presence/AI/AFK counters, deadlines, rules, hashed passwords and hashed resume tokens. All 52 cards must remain accounted for. Canonical checksums and schema/version checks reject corrupted or unsupported snapshots. The server stops startup rather than silently discarding an invalid match.

The single-deck engine deals the whole deck at match start, so hands, pile and discard represent its complete deck state. No new deck is generated during recovery. A rematch creates a new match ID and fresh deck while keeping the room code.

Startup acquires ownership, loads active/finished rooms, invalidates old socket generations, and resolves expired deadlines before listening. Stored absolute turn, pause, AI, provisional, and result deadlines are reused. A restart never grants fresh grace or turn time. Previously connected seats become disconnected, but their original turn deadline remains; if it expires before recovery they enter the existing offline policy. Prompt reconnection preserves human control without an automatic AI penalty.

An in-memory scheduler checks deadlines every 250 ms without writing countdown ticks. It only saves actual transitions. Recovery resolves overdue transitions using their original timestamps. Failed disconnect writes are retried with their original timestamp; recovering storage cannot reset the grace window. The six-hour match limit prevents pathological games from running forever; those matches are abandoned and unranked. Shutdown rejects new mutations and drains in-flight work before releasing ownership.

### PostgreSQL migrations

1. `server/migrations/001_durable_games.sql`: migration checksums, service fencing epoch, room snapshots, action receipts, matches, participants, results and player statistics; recovery/retention/leaderboard indexes; private tables revoked from `PUBLIC`.
2. `server/migrations/002_leaderboard_index.sql`: indexed wins/win-rate ordering for competitive players.

Migrations are ordered, checksum-verified, additive and transactional. They do not replace existing accounts, passwords, sessions, email tokens or historical rows. Applied migration files must never be edited; add another migration. The explicit migration command also initializes the existing additive account schema on a fresh database. Runtime automatic migrations default to **off**.

Private snapshots and their cascading receipts expire after 30 days from completion. Official matches, results and statistics remain. Cleanup runs periodically, not on countdown ticks. Browser-local results are unverified legacy data and are never imported.

### Ownership and database outages

One direct PostgreSQL session holds advisory lock `71638205`; a second process fails startup with `SERVER_ALREADY_RUNNING`. Each transaction locks/checks the service epoch, fencing stale owners even after their original lock connection is lost. The application pool has at most five connections, authentication has at most five, and the dedicated owner adds one. Schema setup temporarily uses one extra direct connection.

Ownership connection loss fails closed and requires a process restart. Ordinary transaction failures leave the prior committed state intact, notify the client, and retry storage synchronization with backoff. Connection/query timeouts bound waits; game SQL and idle-transaction timeouts are set locally inside each transaction, rather than relying on session parameters surviving a transaction pooler. Deadlines continue to reflect real elapsed server time; an outage does not give extra gameplay time. No Redis or persistent local disk is used. See [Neon's pooling constraints](https://neon.com/docs/connect/connection-pooling).

This is explicitly a **single-instance architecture**. A conventional overlapping rolling deployment cannot acquire ownership while the old process is running. Stop the old backend before starting the replacement; allow a maintenance interruption. Do not enable autoscaling or run local development against the live production database. Use an isolated Neon branch for development. No zero-downtime handoff is claimed.

## Official results and rankings

The server alone finalizes a match. `bx_matches.finalized` and the primary key `(match_id, player_id)` make finalization/results idempotent. Finalization and all aggregate increments are atomic. Reconnects, retries, stale writers and repeated finalization attempts cannot add another win.

Each result records placement, rounds, score, winner, completion, mode, outcome reason, forfeit and AI assistance. The match winner places first; remaining non-forfeited seats sort by cards remaining, then forfeited seats by elimination time. Equal remaining-card counts or equal elimination timestamps share placements. Scores track completed claim/reveal rounds; winning the match is a separate outcome and is not an extra score point.

A competitive match needs at least two signed-in humans, no configured practice bots, an authenticated winner who never needed AI assistance, and a non-abandoned outcome. A human winner can receive a ranked last-survivor victory against forfeiting opponents. An AI-assisted winner makes the entire result unranked: no participant receives a competitive win/loss from that match. Guest/practice/abandoned outcomes remain recorded, but do not inflate competitive totals. Forfeits, AI-assisted participation and unranked games have separate counters. Call/accuracy counters describe server-validated actions across recorded games.

`GET /auth/stats` requires a valid session. `GET /auth/leaderboard?page=0&limit=20` returns official statistics, with limits of 50 rows and page 10,000. Ranking uses wins descending, then win rate descending; ties share a rank and stable user IDs order tied rows. The frontend fetches these endpoints, refreshes after finalization and ignores browser-owned match counters. There is no writable leaderboard or client victory endpoint.

## Continuity and competitive rules

* Each seat gets **10 seconds cumulative grace per round**. Repeated disconnects spend the remaining budget. The original grace deadline and consumed time survive reconnects and restarts. The table clock pauses only during eligible grace.
* AI gets **three completed claim/reveal rounds**, tracked against the persistent seat. Brief reconnections do not refill it. Renewal requires at least **60 seconds continuously connected plus a valid gameplay action**. Renewing the budget never erases the historical AI-assisted flag.
* Connected players receive warnings on missed turns one and two. Miss three activates AI, or forfeits when no allowance remains. Only eligible missed turns count. A successful human play/pass/challenge clears consecutive strikes. Clicking reclaim alone does not clear strikes.
* Returning to a disconnected seat requires the seat's private rotating token and matching account when signed in. Signed-in users can also recover their own offline seat using their authenticated account. Socket generations fence older tabs. Raw resume secrets are client-generated; only hashes/expiry enter PostgreSQL, and raw tokens never appear in room broadcasts or acknowledgements. Lost rotation acknowledgements can recover using the pending client proposal.
* Result screens have a persisted **10-second** countdown. The host can advance early; both paths use the same serialized transition. Non-host early advancement is rejected.
* A temporary AI or disconnected human cannot automatically receive a verified victory. The result becomes provisional for **10 seconds**. A valid return finalizes an explicitly **AI-assisted, unranked** win. Otherwise that seat forfeits; the table continues, or the last eligible survivor wins. Another absent survivor receives the same bounded provisional policy. If everyone forfeits the match is abandoned. AFK-controlled humans must reclaim control to confirm their assisted outcome.
* Every single-deck play selects **one through four unique owned cards**. AI goes through the same play/pass/challenge reducers and sees only its own hand plus public claim rank/count. Opponents' hidden card values cannot affect its choice.
* All mutations require a unique action ID; gameplay also requires match/round/turn/claim identifiers from the displayed server state. Stale actions cannot be retargeted to a newer turn. Matching retries return the original committed acknowledgement; conflicting reuse is rejected.

Limits apply per connection, event, account, and guest/setup IP. Defaults are deliberately above normal turn traffic. Payloads are limited to 8 KiB with event-field allowlists; seat/account/controller authorization is server-derived. Cached duplicates do not perform new transactions or room broadcasts. Rate-limit errors are private structured responses. Chat is bounded and deduplicated in memory, but is not part of durable gameplay history. Proxy IP handling trusts only the configured Render hop; shared networks/proxies can share guest limits.

The frontend retains the existing styling, tutorial, beta/version banner, audio and animations, adding authoritative statistics, server result countdown, provisional explanation, AFK notices, recovery/storage status and AI control indicators. Displayed countdowns anchor to server time and advance with the browser's monotonic clock; changing the client wall clock does not change the result timer. The existing release number remains `0.2.0-beta.1` until publication.

## Configuration

Keep existing authentication/email/origin settings and both Neon URLs. No additional provider or secret is required. `DATABASE_URL` is pooled; `DATABASE_URL_UNPOOLED` must be direct for ownership and migrations. Never put either in a `VITE_` variable.

| Variable | Default | Purpose |
| --- | --- | --- |
| `GAME_AUTO_MIGRATE` | `false` | Opt-in schema setup; use explicit reviewed migrations in production |
| `GAME_GRACE_MS` | `10000` | Cumulative per-round disconnect budget |
| `GAME_AI_ROUNDS` | `3` | Persistent temporary-AI round budget |
| `GAME_AI_RENEWAL_MS` | `60000` | Minimum stable connected renewal period; cannot be configured below 60 s |
| `GAME_AFK_STRIKES` | `3` | Consecutive misses before enforcement |
| `GAME_RESULT_MS` | `10000` | Round-result display time |
| `GAME_PROVISIONAL_MS` | `10000` | Assisted winner return window, maximum 30 s |
| `GAME_MAX_CARDS` | `4` | Single-deck maximum; cannot exceed four |
| `GAME_RESUME_MS` | `86400000` | Resume-token and finished-room window |
| `GAME_RETENTION_DAYS` | `30` | Completed private snapshot/receipt retention |
| `GAME_MAX_MATCH_MS` | `21600000` | Six-hour abandonment bound |
| `GAME_MAX_ROOMS` | `500` | Per-owner capacity bound |
| `GAME_STORAGE_TIMEOUT_MS` | `10000` | Connection/SQL statement timeout; query and idle-transaction timeout add five seconds |
| `GAME_STORAGE_CONNECT_ATTEMPTS` | `3` | Bounded retries for transient connection/startup failures; does not replay gameplay |
| `GAME_CONNECTION_BURST` | `30` | New connections per IP; refill one per second |
| `GAME_EVENT_BURST` | `40` | Per-connection event bucket |
| `GAME_EVENT_REFILL` | `8` | Per-connection refill per second |
| `GAME_SETUP_BURST` | `6` | Sensitive setup burst |
| `GAME_SETUP_PER_MINUTE` | `12` | Sensitive setup refill |

Additional fixed protocol limits live together in `rules.js`: account/guest identity 80 burst/12 per second, per-event 20/4 per second, HTTP statistics 20/2 per second, chat 2/1 per second, acknowledgement cache 512, private play-history tail 1,000. Existing rooms persist their original rule configuration across restarts. New settings apply to new rooms.

## Test coverage

`npm test` uses deterministic clocks, in-memory persistence doubles and isolated Socket.IO servers; authentication uses its existing PostgreSQL-compatible fixture. Browser tests use those isolated servers on 4020/5180. Real SQL transactions and process termination are verified separately on an isolated schema-only Neon branch, never the production branch.

| Required scenario | Automated coverage |
| --- | --- |
| 1. Restart during turn | `durable-pg`, `restart-pg`, `reliability` |
| 2. Restart after challenge | `durable-pg`, `restart-pg`; transactional penalty/reveal |
| 3. Restart during results | `durable-pg`, `restart-pg`; original deadline retained |
| 4. Restart during AI | `durable-pg`; active takeover, counters and grace restored |
| 5. Simultaneous finalization | `durable-pg`; duplicate leave and repeated transaction |
| 6. Duplicate play | `durable-pg`, `reliability`, `flood`; one receipt/version |
| 7. Stale later-turn action | `reliability`, `durable-pg`; envelope/version rejection |
| 8. Repeated disconnect exploit | `reliability`; five flaps and cumulative budget |
| 9. Third AFK miss | `reliability`; single AI controller, reclaim/action distinction |
| 10. AFK host results | `reliability`, `durable-pg`; automatic deadline transition |
| 11. Simultaneous challenges | `reliability`, `durable-pg`; exactly one accepted |
| 12. Malicious cards/ownership | engine, `reliability`, `flood` |
| 13. Fake victory | `reliability`, `flood`; unknown event rejected |
| 14. Edited rankings | `flood`; POST rejected; browser `authority.spec` ignores forged localStorage |
| 15. PostgreSQL failure mid-play | `durable-pg`; connection closed before commit and SQL receipt failure both roll back |
| 16. Resume replay/seat theft | `reliability`, live `reconnect`; token rotation/account mismatch |
| 17. AI winning absent | `reliability`; provisional return/expiry and fully abandoned outcome |
| 18. Host/automatic race | `durable-pg`, `reliability`; one new round |
| 19. Event floods | `flood`; 100 duplicate and 100 invalid attempts without room-wide flood |
| 20. Fresh socket after recovery | `restart-pg`; real server SIGKILL twice and new clients |

Additional tests cover 60-second renewal, no meaningful-action renewal, AI hidden-information invariance, leaderboard ties/pagination, stale writer fencing, auth cookies, existing account import, tutorial, mobile layouts, guest/practice/private rooms and rematches. Google token verification is mocked in auth tests; no live Google consent or email delivery was performed by this change.

### Running isolated database checks

Create a schema-only development branch with the existing account schema. Explicitly provide its **direct** URL as `TEST_DATABASE_URL` and exact hostname as `TEST_DATABASE_HOST`, then run `npm run test:postgres`. The preload never selects the application's production `.env` implicitly. A private ignored local test configuration can also identify the temporary branch used during development. Tests create/retire only their own accounts/rooms; no global reset is used. Do not point this command at a production database.

The temporary branch used here is `reliability-check-20261112`, expiring 2026-11-15. It contains no copied production account rows. No secrets are committed. The test branch has not been automatically deleted.

### Actual final verification — 2026-11-12

| Command/check | Actual result |
| --- | --- |
| `npm test` | 54 tests: **52 passed, 0 failed, 2 skipped**; 13.28 s |
| `npm run test:postgres` | **16 passed, 0 failed, 0 skipped**; 195.62 s on isolated Neon |
| `npm run test:e2e` | **11 passed**; 50.0 s in Chrome |
| `npm run build` | **Passed**, 58 modules transformed; built in 3.88 s |
| `node --check` for server JavaScript | **33 files passed** |
| Prettier checks on changed production JS/JSX/CSS | **Passed** |
| `git diff --check` | **Passed**; only Git's Windows line-ending notices |
| Explicit migration script on isolated branch | `Game migrations applied and verified. Existing accounts unchanged.` |

The two tests skipped by the ordinary server command are the opt-in real-database suites; both run successfully in `test:postgres`. There is no TypeScript project or existing standalone ESLint command. JavaScript syntax, formatting, production compilation and executable behavior were checked instead. Authentication, public/private rooms and guest/practice flows remain covered by the existing adapted suites. Browser verification also covers a missing finalization notification: a recovered finished snapshot still refreshes server-owned profile statistics.

Representative final command output:

```text
npm test
tests 54
pass 52
fail 0
skipped 2

npm run test:postgres
tests 16
pass 16
fail 0
skipped 0

npm run test:e2e
11 passed (50.0s)

npm run build
58 modules transformed.
built in 3.88s
```

Intermediate failures were resolved before these final runs: initial timeout settings were replaced with transaction-local settings; intermittent Neon connection timeouts/resets led to bounded startup retries and avoiding unnecessary migration work on test restarts; a process-restart assertion was corrected to expect automatic advancement when the original results deadline elapsed during startup. The corrected restart test verifies the next turn derives from the original deadline. A provisional-outcome test was also updated to require an absent last survivor to return, rather than awarding that disconnected seat a win.

All eight priorities have implemented code and automated coverage. Live provider OAuth consent, external email delivery, production deployment and production restart acceptance were intentionally not performed.

## Files changed

Created:

* `server/migrations/001_durable_games.sql`, `server/migrations/002_leaderboard_index.sql`.
* `server/src/game-store.js`, `server/src/room-service.js`, `server/src/results.js`, `server/src/protocol.js`, `server/src/rules.js`.
* `server/scripts/migrate-games.js`.
* `server/test/durable-pg.test.js`, `server/test/restart-pg.test.js`, `server/test/reliability.test.js`, `server/test/flood.test.js`.
* `server/test/memory-game-store.cjs`, `server/test/real-db-env.cjs`, `server/test/socket-client.cjs`.
* `client/tests/authority.spec.js`, `docs/reliability-overhaul.md`.

Modified:

* `server/src/index.js`, `server/src/game.js`, `server/src/presence.js`, `server/src/database.js`.
* `client/src/App.jsx`, `client/src/components.jsx`, `client/src/lib/socket.js`, `client/src/index.css`.
* `server/test/postgres-fixture.cjs`, `server/test/socket.test.js`, `server/test/reconnect.test.js`, `client/tests/game.spec.js`, `client/tests/reconnect.spec.js`.
* `package.json`, `server/package.json`, `server/.env.example`, `render.yaml`.
* `README.md`, `docs/deployment.md`, `docs/gameplay-beta.md`.

No production secrets or dependency changes are included. Package script changes do not change dependency lockfiles.

## Release procedure and limitations

1. Review this change and the two additive migrations. Before the first upgrade, finish matches running on the old in-memory implementation; those unpersisted old-process matches cannot be recovered retrospectively.
2. Arrange a maintenance window and stop the existing backend owner. Disable automatic overlapping deployments for this rollout. Do not run a second local backend against production.
3. In an operator-controlled environment with the intended Neon URLs, run `npm ci`, `npm --prefix server ci`, then `npm run db:migrate-games`. Confirm the migration success message and preserve provider backups/restore history. This command does not import browser records or reset account data.
4. Keep Render root `server`, build `npm ci --omit=dev`, start `npm start`, health `/health`, one instance, both URLs, existing auth/mail/origin settings and `GAME_AUTO_MIGRATE=false`. Start the replacement after the old owner has exited.
5. Publish the matching client to Vercel (`client`, `npm run build`, output `dist`). Keep its existing same-origin `VITE_SERVER_URL` and proxy routes. Old clients lack mandatory sequence/rotation fields; reload them during this coordinated release.
6. Verify health, login/reload, public/private rooms, reconnect, a result/leaderboard update and an operator-controlled restart. Test Google and actual Resend delivery with the configured providers separately. Only run the existing production `check:deployment` account-creating script if explicitly authorized.

There is no multi-instance scaling or zero-downtime ownership handoff. Rate buckets are process-local and reset on restart, while action receipts/AFK/grace/AI budgets remain durable. Offset leaderboard pagination is bounded; a much larger leaderboard may warrant a cursor endpoint. The snapshot is private backend data, not application-level encrypted JSON; Neon access credentials must remain server-side. Database/network outage coverage closes a real test connection mid-transaction; it does not simulate every possible regional/provider failure. Local builds/tests do not establish live Render/Vercel rollout success. The existing Browserslist age notice and Node SQLite-import experimental notice are informational test/build warnings, not newly introduced failures.
