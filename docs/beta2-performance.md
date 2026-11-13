# BluffX v0.2.0-beta.2 — AFK and performance report

Implemented locally; not published to Render or Vercel. The default deployment check confirms the live service still reports `0.2.0-beta.1`. Production game data was not changed. Baseline measurements used the working beta.1 source before these optimizations, including the preceding durability overhaul, not a load test against the live deployment.

## Findings and measured changes

The baseline had no idle SQL polling, which was preserved. Its principal avoidable costs were seven sequential game SQL calls per normal action, full per-player room snapshots after every commit, repeated private-hand delivery, room-wide serialization even when settling a deadline that was not due, and a 250 ms scan of every room. The React app also redrew its entire table every 500 ms to update clocks.

Database round trips dominated the isolated Neon action measurements. Local Socket.IO and simulated persistence were much faster. These are separate from network latency between real users/Render/Vercel, Render cold starts, and browser rendering cost. No Render CPU or cold-start duration was inferred from the local benchmark.

### Repeatable workload

`server/scripts/load-game.js` creates actual Socket.IO clients and simultaneous rooms, deals real shuffled decks, plays legal cards, challenges and advances rounds. It measures acknowledgement latency, process CPU, event-loop delay, memory, persistence, outgoing application notifications/bytes and SQL driver calls. It then idles for two seconds and exercises disconnect, grace expiry, missed turns and lightweight AI through an injected server clock. Production game constants are not shortened. No external AI is called.

All load clients share loopback, so the harness explicitly disables rate limiting **in its own process**. Flood/rate enforcement is tested separately. Normal action deadlines are held against an injected clock during the measured workload to prevent network jitter from changing which turns are being compared. CPU values include the local server, load clients, driver/test double, V8 and helper threads. SQL results below come from the isolated Neon branch; local capacity results use the explicit in-memory test double. Neither is a Render Free capacity guarantee.

Raw, hand-free JSON artifacts:

* [Beta.1 local baseline](performance/beta1-baseline.json)
* [Beta.2 local optimized](performance/beta2-optimized.json)
* [Beta.1 isolated Neon](performance/beta1-neon.json)
* [Beta.2 isolated Neon](performance/beta2-neon.json)
* [Beta.2 constrained-heap stress](performance/beta2-stress.json)

| 20 rooms, 40 clients, 160 rounds / 480 actions, 128 MB V8 heap limit | Before | After | Reduction |
| --- | ---: | ---: | ---: |
| Average acknowledgement | 17.30 ms | 12.23 ms | 29.3% |
| p95 acknowledgement | 24.56 ms | 15.68 ms | 36.1% |
| CPU during measured round workload | 641 ms | 407 ms | 36.5% |
| Outgoing application notifications | 2,254 | 1,280 | 43.2% |
| Notification payload bytes | 3,811,507 | 1,307,745 | 65.7% |
| Receipt lookups during fresh actions | 480 | 0 | 100% |
| Durable commits | 480 | 480 | Unchanged |
| End RSS | 109.13 MiB | 108.86 MiB | Essentially flat |

| 3 rooms, 6 clients, 6 rounds / 18 actions, real isolated Neon | Before | After | Reduction |
| --- | ---: | ---: | ---: |
| Average acknowledgement | 1,645.95 ms | 800.56 ms | 51.4% |
| p95 acknowledgement | 2,825.59 ms | 1,931.44 ms | 31.6% |
| SQL driver calls | 126 | 54 | 57.1% |
| SQL calls per action / completed round | 7 / 21 | 3 / 9 | 57.1% |
| Outgoing application notifications | 84 | 48 | 42.9% |
| Notification payload bytes | 142,854 | 48,882 | 65.8% |
| End RSS | 73.28 MiB | 73.80 MiB | Slight increase |

The larger memory-backed run completed **100 rooms, 200 initial clients, 1,000 rounds and 3,000 actions** under `--max-old-space-size=64`: average acknowledgement **111.16 ms**, p95 **187.02 ms**, end RSS **136.90 MiB**, used heap **36.13 MiB**. V8's heap limit is not a total RSS limit or a CPU quota. The sampled event-loop p95 was **94.18 ms** under this intentionally simultaneous burst; this is not claimed as a normal human-paced or Render measurement. The 20-room and real-Neon runs both had event-loop p95 around 32 ms on this Windows host; no material event-loop-delay improvement is claimed.

Every measured two-second idle window had **zero SQL calls, receipt reads, writes and outgoing application notifications**. A socket regression also verifies zero scheduler wakeups during idle time before a deadline. Notification counts/bytes exclude acknowledgement packets, Engine.IO heartbeats and transport headers, consistently in both versions. RSS includes local simulated clients; it is not backend-only cloud RSS. Periodic peak-RSS samples are taken every 100 ms and can miss short/final allocation spikes. No general RSS reduction is claimed. Total-process CPU, including setup/cleanup and runtime noise, is available in the artifacts; the improvement quoted is specifically the measured round workload.

These are single repeatable samples with small real-Neon volume. Random card deals, GC, OS scheduling, concurrent programs and geographic database latency affect results. Re-run the workload in a staging region matching Render before setting production concurrency targets.

```powershell
# Local capacity check; never selects the application's production database:
npm run test:load -- --rooms 20 --rounds 8
node --max-old-space-size=64 server/scripts/load-game.js --rooms 100 --rounds 10

# Only with explicitly configured isolated TEST_DATABASE_URL and TEST_DATABASE_HOST:
npm run test:load -- --postgres --rooms 3 --rounds 2
```

## AFK and controller behavior

Each persisted seat is normalized to one controller classification: `HUMAN_ACTIVE`, `HUMAN_AFK_WARNING`, `HUMAN_AFK_FINAL_WARNING`, `OFFLINE_GRACE`, `AI_CONTROLLING`, or `REMOVED`. Existing connection/AI flags remain compatible fields, normalized together by the presence layer rather than independent controllers. Takeover reason is separately `afk` or `offline`.

1. First eligible expired turn: the original legal timeout/default action runs, one strike is recorded, the table sees Possibly AFK and the player sees “You missed your turn. Are you still playing?”
2. Second: original timeout action, final warning and “One more missed turn triggers AI takeover.” No extra time is added.
3. Third: the same hand/seat enters lightweight AI control, with the existing three-completed-round budget and no AFK grace pause. Available human host privileges transfer when needed.
4. Only a valid human play, pass or challenge clears consecutive strikes. Chat, focus, heartbeat, reconnect, rejected actions and AI moves do not. Waiting, pauses and result screens do not accrue strikes. Versioned durable deadline transitions prevent double-counting.
5. Connected players use **I'm Back — Take Control**. The room queue serializes this against AI actions; an already committed AI move remains. Reclaim is scoped to the authenticated seat/generation and current match, rather than being accidentally blocked by an AI move changing the turn while the request was in flight. It never resets the currently running deadline, replaces cards, clears strikes or refills usage.
6. Disconnecting while AFK AI already controls the seat preserves that controller and usage. There is no fresh grace cycle. A normal offline reconnect retains the existing secure recovery behavior; a second tab taking over a still-connected AFK seat does not silently cancel AI.
7. At the same server timestamp, a deadline already reached is resolved before the disconnect transition. If disconnect is detected earlier, only genuine remaining time is frozen. Both queue orderings are tested.

AI remains a small legal-move selector using only its own hand and public claim information. It runs only when scheduled to act. No model, API, simulations or thinking loop is added. AI-assisted/provisional wins remain visibly unranked; the bounded return/forfeit policy and exactly-once authoritative statistics are preserved.

## Offline regression guarantees

The original 10-second **cumulative per-round** grace, independent simultaneous disconnect deadlines, exact remaining-turn resumption, unchanged 4-second ping interval/timeout, private rotating resume tokens, stable identity/hand, three completed claim/reveal rounds, discard retirement and 52-card invariant remain covered by the existing tests. Three rounds are not three turns. Brief returns do not refill AI usage; eligible renewal still requires at least 60 seconds continuously connected and meaningful human activity.

Explicit leave/logout/revocation still bypass grace. Three completed AI rounds without recovery remove an AFK-controlled seat even if its socket remains connected. Last-survivor and absent-survivor provisional victory rules remain. Result screens still advance after their original 10-second absolute deadline, including after restart. Database failures never acknowledge or broadcast an uncommitted play; failed disconnect writes retain their original detection timestamp.

## Resource changes

* **Scheduling:** one indexed deadline heap with one timer and bounded concurrent room work, plus the existing hourly retention task. No 250 ms global room scan. Updating a room replaces its heap entry rather than leaving stale timer entries. Failure retries use backoff; recovered retries clear their old deadline. Original absolute deadlines are preserved.
* **Delivery:** one sanitized common projection per committed room state; protocol-2 clients get ordered `room_patch` changes. Only an owner's changed hand is attached to that owner's patch. Snapshots are used for initial bind, recovery, a version gap, explicit synchronization or legacy clients. Unchanged versions are not re-emitted. Broadcast traversal uses the room's socket membership rather than scanning every socket on the server. Storage notifications only emit on availability changes.
* **Database:** fresh version-tagged actions avoid the preliminary receipt query. Durable uniqueness still rejects reused IDs; retries of earlier actions consult stored receipts. Existing cached duplicates perform no transaction or broadcast. One transactional protocol call begins the transaction, configures local timeouts and obtains the fencing lock; a CTE atomically updates the snapshot and inserts its receipt; COMMIT finishes it. Participant inserts are batched. The same number of durable gameplay commits is retained. SQL call counts measure driver/protocol calls, not a claim that fewer rows are durably stored; a control call contains multiple SQL statements. Parameterized game data, version checks, fencing, rollback and commit-before-ack remain.
* **Queries audited:** recovery is one query containing each room's seats, leaderboard pagination/ranking remains SQL-based, receipt reads were removed from fresh hot paths, and no new global joins or per-player recovery queries were added. Session checks remain authoritative per authenticated action; no stale authorization cache was introduced. Small existing profile/statistics reads were retained rather than weakening auth to chase query counts.
* **Memory:** game/auth pools default to four/two connections plus one direct owner, down from five/five plus owner. Acknowledgement caches remain bounded; participant-ledger knowledge is bounded. Recent private play history and round-score detail cap at 128 entries, while live deck/claim state, score totals and durable action receipts remain authoritative. Completed tables close after five minutes, not a day; official results remain in Neon. Limiter maps are bounded and per-socket entries/listeners are removed on disconnect. Shutdown clears live projections, room caches and scheduler entries after draining commits.
* **Browser:** one shared clock drives small deadline components; the parent table has no half-second state timer. Monotonic time is anchored to server timestamps, so a changed browser wall clock cannot decide expiry. Disconnected/not-ready gameplay is rejected locally, queued socket sends are cleared and retries are not transferred to a new connection. Authentication and connection startup retry with bounded delays and display “Connecting to BluffX server...”. No fake keep-alive or more frequent heartbeat is introduced. Mobile overlays avoid backdrop blur.

## Diagnostics and configuration

`GAME_DIAGNOSTICS=true` enables bounded latency sampling and event-loop diagnostics. In development only, loopback `GET /debug/metrics` returns active rooms/sockets, average action and persistence latency, p95 of the last 256 samples, SQL calls, notifications/bytes, counters per completed round, CPU, RSS/heap and managed scheduler/retention timer counts. Counters are aggregate: no room IDs, accounts, resume secrets or card data. There is no verbose production logging or public production metrics endpoint. Production diagnostics default off.

| New setting | Default | Meaning |
| --- | ---: | --- |
| `GAME_POOL_SIZE` | 4 | Game pool and scheduler concurrency; 1–8 |
| `AUTH_POOL_SIZE` | 2 | Auth pool; 1–5 |
| `GAME_FINISHED_MEMORY_MS` | 300000 | Five-minute completed-table/rematch window; 1 s–1 h |
| `GAME_DIAGNOSTICS` | false | Explicit opt-in bounded diagnostics |

All previous gameplay/grace/AI/AFK/timeouts configuration remains. Pool sizes are process-wide; existing persisted game rules are respected. The finished-table lifetime is an intentional resource-policy change: after that window reconnect/rematch needs a new table, while official results remain available.

## Database and compatibility

**No new beta.2 SQL migration.** The existing reliability migrations `001_durable_games.sql` and `002_leaderboard_index.sql` remain required and unchanged. New controller data fits the existing private JSON snapshot. Schema-1 active matches load, normalize controller metadata, preserve cards/scores and resolve deadlines without a new deal. No account/session rewrite or legacy-browser score import is performed.

Protocol-1 clients retain safe snapshot delivery. Deploy the matching beta.2 client for incremental events; clear version gaps with a fresh authoritative snapshot. Version updates cover all three package manifests/locks, initial HTML and the existing release strip used by account/login/game screens. Tutorial and How to Play explain warnings and deliberate recovery.

## Files in this release

Created: `server/src/deadline-scheduler.js`, `server/src/room-delivery.js`, `server/src/diagnostics.js`, `server/scripts/load-game.js`, `server/test/beta2.test.js`, `server/test/beta2-socket.test.js`, `client/src/Deadline.jsx`, `client/src/lib/clock.js`, `client/src/lib/room-state.js`, `client/tests/afk.spec.js`, `client/tests/cold-start.spec.js`, this report and five raw JSON performance artifacts.

Updated: `server/src/index.js`, `room-service.js`, `presence.js`, `game-store.js`, `game.js`, `protocol.js`, `rules.js`, `database.js`; `server/test/socket-client.cjs`, `memory-game-store.cjs`; `server/scripts/check-deployment.js`; `client/src/App.jsx`, `components.jsx`, `auth.jsx`, `TutorialGame.jsx`, `index.css`, `lib/socket.js`; `client/tests/reconnect.spec.js`; all package manifests/lock versions, `client/index.html`, `server/.env.example`, README and deployment/gameplay/reliability documentation. `.gitattributes` now preserves migration SQL LF endings so Windows/Linux checkouts do not change checksums. Earlier uncommitted durability files remain part of the working release; they were not discarded.

## Verification and limitations

The existing server, browser and isolated PostgreSQL regressions are preserved. New coverage maps to the requested cases as follows:

| Cases | Coverage |
| --- | --- |
| 1–4: strikes, reset, takeover, reclaim | `beta2.test.js` and real 20-second-turn `afk.spec.js` |
| 5–6: warning/AI disconnect | `beta2.test.js`, preserving consumed allowances |
| 7–10: independent grace, completed rounds, deck retirement, AFK host | Existing presence/reliability tests; real browser AFK test waits through automatic result advancement |
| 11: simultaneous timeout/disconnect | Both orderings in `beta2.test.js` |
| 12–13: duplicate events, human/AI race | Flood/idempotency tests; both reclaim/AI queue orderings |
| 14–16: AI restart, SQL outage, deadline recovery | `beta2`, real Neon `durable-pg` and abrupt `restart-pg` tests |
| 17: room/listener cleanup | `beta2`, `beta2-socket` and scheduler heap cleanup |
| 18: multi-room constrained load | 100-room/3,000-action, 64 MB heap script result |
| 19: cold start reconnect | `cold-start.spec.js`, existing reload/tab recovery and real server termination tests |
| 20: idle database traffic | Live socket idle regression and all benchmark idle windows |

Actual final results, 2026-11-12; browser tests remain isolated on **4020/5180**:

| Command/check | Actual result |
| --- | --- |
| `npm test` | **68 tests: 66 passed, 0 failed, 2 skipped**, 12.30 s |
| `npm run test:postgres` | **16 passed, 0 failed, 0 skipped**, 103.73 s against isolated Neon |
| `npm run test:e2e` | **13 passed**, including real timed AFK and cold-start recovery; 1.9 min |
| `npm --prefix server run check:deployment` | **Passed read-only checks**; live version `0.2.0-beta.1` |
| `npm run build` | **Passed**, 61 modules; latest build 1.92 s |
| JavaScript syntax | **39 server files passed** `node --check` |
| Changed production formatting / whitespace | **Prettier and `git diff --check` passed** |
| 20-room / 3-room SQL / 100-room stress scripts | **Completed successfully**, raw artifacts linked above |

The two ordinary-test skips are the opt-in real PostgreSQL suites, both executed successfully by the separate PostgreSQL command. There is no TypeScript project or existing standalone ESLint script; executable tests, syntax, formatting and production compilation were checked. The final configurable-threshold metadata regression is additionally covered by the server suite.

```text
npm test
tests 68
pass 66
fail 0
skipped 2

npm run test:postgres
tests 16
pass 16
fail 0
skipped 0

npm run test:e2e
13 passed (1.9m)

npm --prefix server run check:deployment
PASS read-only backend health; deployed version: 0.2.0-beta.1
PASS frontend availability
PASS same-origin authentication proxy endpoints
Read-only checks complete. No account, session or match created.
```

Intermediate test failures were corrected: the first load harness advanced across two sockets before the other client received its state; it now waits for version synchronization. Retry helpers now preserve the original version envelope instead of changing it on duplicate sends. A race test now accounts for the AI's legal two-card move rather than assuming one card. The new browser AFK test initially clicked a covered card in fan view after recovery; it now uses the existing Show all cards grid. These were harness/assertion issues; the final checks above pass.

Known limits: this remains one database-fenced backend owner, with a maintenance handoff rather than overlapping rolling deployments. Rate buckets are process-local. Legacy clients send larger snapshots. Neon benchmarks use guests; authenticated actions retain an additional session lookup. A memory-backed 100-room run does not establish 100-room real-Neon or Render capacity. Cold-start recovery is tested through interrupted startup/session requests and real process termination, not a timed live Render suspension. Live Google consent and Resend delivery were not exercised. Build/test informational Browserslist/Node warnings remain.

## Safe deployment

1. Review the working changes. Do not run local development/load tests against production. Back up/retain Neon restore capability and finish unpersisted matches on any older in-memory backend before the first reliability upgrade.
2. If 001/002 have not been applied to the intended production database, explicitly run the reviewed `npm run db:migrate-games` in an operator-controlled maintenance window. Beta.2 adds no migration and performs no production migration automatically. Keep `GAME_AUTO_MIGRATE=false`.
3. Stop the old backend owner before starting the replacement. Use one Render instance, existing `server` root, `npm ci --omit=dev`, `npm start`, `/health`, pooled/direct Neon URLs and existing auth/mail/origin settings. The advisory lock/fencing rejects a second owner. Keep diagnostics off unless deliberately profiling.
4. Publish the matching Vercel client (`client`, `npm run build`, `dist`), retaining the existing same-origin URL/proxies. No database or mail secret belongs in `VITE_` variables. Reload clients to use patch delivery.
5. Run `npm --prefix server run check:deployment`: it now performs read-only live health/frontend/auth-proxy checks and creates no user/session/match. Full account-creating mode is restricted to explicit isolated local configuration. Run new-feature tests on staging before asking real users to resume.
6. Observe actual warm action latency, regional database round trips, queue time and memory under expected traffic before adjusting room capacity. The measurements here justify the code changes, not a guaranteed production SLA. No paid infrastructure, external AI, fake keep-alive, production push or automatic deployment was introduced.
