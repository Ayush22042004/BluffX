# BluffX beta version 2 - complete implementation record

## Identity and release status

| Field | Value |
| --- | --- |
| Record date | 2026-11-13 |
| Development cycle | `v0.2.0-beta.2` / beta version 2 |
| Current package version | `0.2.0` in workspace, client and server |
| Current interface | Production styling and version/build markers; development/beta warning banners removed at the user's request |
| Last observed deployed backend | `0.2.0-beta.1`, read-only check on 2026-11-13 |
| Current rollout status | Implemented and tested locally; this work has not been deployed to production |

This is the consolidated record of the accumulated beta version 2 work: the multiplayer reliability overhaul, AFK/performance update, avatar and seating improvements, production UI cleanup, continuous voice and TURN integration, and closed-playtest controls. The name of this document preserves the beta development history; it does not change package versions or restore beta banners.

## Existing features preserved

The React/Vite frontend, Express/Socket.IO backend, Neon PostgreSQL accounts, email and Google sign-in, Resend HTTPS email integration, room codes, public/private tables, passwords, ready/start flow, chat, tutorial, card animations and existing neon visual design remain in use. The implementation extends the existing architecture rather than introducing a replacement backend or new matchmaking service.

Selective bluff challenges remain: a caller chooses positions in the previous face-down play. Any selected false card makes the claim fail; all selected cards matching the claim makes the challenge fail. The loser takes the pile. Final claims still require opponents to pass or challenge. Official results come from the server, not browser storage.

## 1. Durable multiplayer state and restart recovery

- Active matches persist in Neon with private hands/deck state, seats, authenticated identities, claims, pile/discard, scores, controller metadata, token hashes, sequence numbers and absolute deadlines.
- Per-room queues serialize mutations. PostgreSQL transactions, version checks, action receipts and owner fencing protect durable state transitions. A committed action is acknowledged and broadcast only after persistence succeeds.
- Startup verifies migrations and saved snapshot integrity, reconstructs rooms and restores original deadlines. It does not redeal cards, reset scores or grant fresh time. Expired actions settle through the normal rules.
- A direct database connection holds the single-owner advisory lock. Multiple processes cannot independently mutate the same persisted match.
- Loss of the ownership connection pauses unsafe work. The supervisor closes the failed generation and retries recovery with bounded backoff, loading the last durable state into a fresh generation.
- Graceful shutdown stops scheduled work, drains accepted mutations and closes sockets/database connections. Abrupt termination recovery uses committed PostgreSQL state.
- Temporary database failures reject/pause mutations safely instead of silently continuing in memory. Private snapshots and raw resume tokens are excluded from public room projections.

Main code: [game-store.js](../../server/src/game-store.js), [room-service.js](../../server/src/room-service.js), [recovery.js](../../server/src/recovery.js), [index.js](../../server/src/index.js). Detailed design: [reliability overhaul](../reliability-overhaul.md).

## 2. Authoritative results and leaderboards

- Matches, participant results and aggregate player statistics are finalized transactionally with uniqueness protection against duplicate results.
- Wins, losses, games played and win rate are returned from server endpoints. Rankings use server statistics, defined tie behavior and bounded pagination.
- Reconnects, retries and simultaneous finalization cannot count the same result twice. Client-supplied victories and edited localStorage do not become official records.
- Guests, practice/bot games and AI-assisted outcomes are distinguishable from verified competitive wins. Legacy browser results are not imported as trusted scores.
- Ranked eligibility requires verified human accounts by default. Closed playtests can force all outcomes unranked.
- A configurable daily winner/opponent-pair cap defaults to three ranked results per UTC day; excess matches finish as unranked without corrupting other participants' outcomes.

Main code: [results.js](../../server/src/results.js), [game-store.js](../../server/src/game-store.js), [launch-controls.js](../../server/src/launch-controls.js), [App.jsx](../../client/src/App.jsx).

## 3. Offline handling and secure reconnection

- A disconnected player keeps their seat, identity and hand. The table sees offline status.
- The reconnect pause uses a cumulative ten-second budget per round and independent absolute grace deadlines. Repeated disconnects do not grant a fresh full budget.
- The eligible turn resumes its exact remaining time. A refresh/socket change does not reset the clock, AFK history or AI usage.
- Grace expiry enables temporary AI using the same hand for at most three completed claim/reveal rounds, counting the current round if it completes after takeover. This is not three individual turns.
- Returning before removal restores the authorized seat. Resume credentials rotate, are stored as hashes, expire and are checked with authenticated identity/seat generation where applicable.
- Brief reconnects do not refill AI allowances. Eligible renewal requires at least 60 seconds of continuous connection and meaningful accepted human gameplay.
- Expired seats are removed; their cards retire to discard, turn ownership is recalculated and the 52-card invariant is preserved. The surviving eligible player receives the appropriate outcome.
- Explicit leave, logout and session revocation bypass reconnect grace. Host privileges transfer to an available human where required. Completed abandoned rooms are cleaned up.

Main code: [presence.js](../../server/src/presence.js), [protocol.js](../../server/src/protocol.js), [socket.js](../../client/src/lib/socket.js).

## 4. Connected-player AFK enforcement

| Eligible missed turn | Server behavior | Player/table feedback |
| --- | --- | --- |
| First | Existing legal timeout action; one consecutive strike | Possibly AFK; missed-turn warning |
| Second | Existing timeout action; two strikes; no added time | Final warning: next missed turn activates AI |
| Third | Same seat/hand enters temporary AI; no offline grace added | AI takeover announcement and Take Control button |

- The persisted controller states are `HUMAN_ACTIVE`, `HUMAN_AFK_WARNING`, `HUMAN_AFK_FINAL_WARNING`, `OFFLINE_GRACE`, `AI_CONTROLLING` and `REMOVED`. AI takeover reason is tracked separately as `afk` or `offline`.
- Only an accepted voluntary human play, pass or challenge resets consecutive strikes. Chat, voice, focus, heartbeat, reconnect and AI actions do not.
- Waiting for opponents, pauses, AI-controlled turns and result screens do not accrue human AFK strikes. A timed-out turn is counted once across retries/recovery.
- Connected AFK players use **I'm Back - Take Control**. Reclaim is authorized and serialized against AI moves; it does not undo committed moves, replace cards, restart a timer or replenish allowance.
- Disconnect during AFK AI continues the existing controller/allowance rather than creating another grace cycle. An already expired deadline resolves before a simultaneous disconnect can grant extra time.
- Unrecovered AFK AI seats are removed after the completed-round allowance even if their socket remains connected.

Main code: [presence.js](../../server/src/presence.js), [room-service.js](../../server/src/room-service.js), [rules.js](../../server/src/rules.js). Rules are also explained in the tutorial and How to Play.

## 5. Game integrity, scheduling and continuity

- Server-issued match, round, turn and claim sequences bind gameplay to the intended state. Action IDs support idempotent retries with stored acknowledgements.
- Stale, expired, unauthorized, duplicate/impossible card selections and out-of-turn actions are rejected. Applicable single-deck plays are limited to four unique owned cards.
- Human and AI actions use the authoritative engine and serialized seat ownership. Simultaneous challenges resolve once.
- AI is a small bounded legal-move selector using its own hand and public information; no opponent-hand inspection, external AI service, model or continuous thinking loop is introduced.
- Result screens use a ten-second absolute next-round deadline. The host can advance earlier through the same transition; automatic/manual races cannot initialize two rounds.
- Absent AI-controlled winners enter a bounded provisional flow. They cannot gain an unqualified verified human victory; AI participation/forfeit reasons are recorded, and the table reaches a definitive outcome.
- Gameplay/setup/reconnect events have bounded per-connection and account/browser/IP protections, schema/size validation and structured rate-limit errors. Duplicate acknowledged requests do not cause duplicate broadcasts or writes.

Main code: [game.js](../../server/src/game.js), [protocol.js](../../server/src/protocol.js), [deadline-scheduler.js](../../server/src/deadline-scheduler.js), [rate-identity.js](../../server/src/rate-identity.js).

## 6. Lightweight backend and frontend performance

- One managed indexed deadline scheduler replaces repeated room scanning. Timers are based on absolute deadlines; no per-second database countdown writes or room-wide tick broadcasts are required.
- Ordinary updates use sanitized versioned room patches. Full snapshots are reserved for initial synchronization, recovery/version gaps and compatible legacy delivery. Private hands go only to their owners and are resent when needed.
- Fresh action processing avoids unnecessary receipt lookups while retaining durable duplicate protection. Participant writes are batched and transactional protocol round trips reduced.
- Default pools are four game connections, two auth connections and one direct owner connection. No Redis, message broker or extra paid compute is introduced.
- Bounded caches/history, expired credential cleanup, listener/timer cleanup and a five-minute completed-table memory window limit retained state. Official results remain in PostgreSQL.
- Small client deadline components share a server-anchored clock instead of rerendering the entire table every half second. Recovery/loading states and bounded retries handle cold starts; stale queued actions are discarded.
- Sampled diagnostics record aggregate action/persistence latency, event-loop delay, memory, SQL calls and application delivery counts without hands or resume credentials.

Historical like-for-like local benchmark: 20 rooms / 480 actions improved average acknowledgement from 17.30 to 12.23 ms, p95 from 24.56 to 15.68 ms, outgoing notifications by 43.2% and payload bytes by 65.7%. A small isolated-Neon comparison reduced SQL driver calls from seven to three per action and average acknowledgement from 1,645.95 to 800.56 ms. These are the earlier optimization samples, not measurements of the later expanded release or Render performance.

The later 2026-11-13 load run completed 360 actions / 120 rounds / 20 rooms using an in-memory persistence test double and a 128 MiB heap limit: average 21.70 ms, p95 34.38 ms, RSS 112.8 MiB, used heap 37.6 MiB, 960 application messages and 981,713 bytes. The two-second idle window produced zero commits, messages or receipt lookups. Workloads differ; these two runs are not a direct before/after comparison. No general memory reduction or Render capacity guarantee is claimed.

Evidence and raw baseline artifacts: [performance report](../beta2-performance.md), [load script](../../server/scripts/load-game.js).

## 7. Avatars, bot names, seating and UI

- Players can upload an avatar; the client prepares a bounded image and the backend validates/stores a small WebP avatar in PostgreSQL rather than relying on Render disk.
- Uploaded avatars use bounded storage/cache behavior, account association and expiring guest support. Existing built-in avatars remain usable.
- AI opponents use simple numbered Bot names rather than arbitrary human names.
- Seat labels and player order follow clockwise turn order, with the local player placed at the bottom. Player names/order indicators agree between table and player list.
- Responsive layout work covers lobby/gameplay panels, card fan/grid positioning, long names, action areas, chat and voice. Existing design, animations and tutorial are retained.
- Development/beta warning strips were removed from loading, account/login and gameplay surfaces; package/build identification remains available.

Main code: [avatars.js](../../server/src/avatars.js), [avatar-upload.js](../../client/src/lib/avatar-upload.js), [seating.js](../../client/src/lib/seating.js), [components.jsx](../../client/src/components.jsx), [index.css](../../client/src/index.css). Reports: [avatars/seating](../avatars-and-seating.md), [UI audit](../ui-audit.md).

## 8. Table voice and continuous audio

- Opt-in WebRTC mesh voice works within the existing small table size. Join Voice starts listening without opening the microphone; Unmute requests capture.
- Mute releases capture and replaces the sender track without destroying the call. Deafen and per-player volume affect playback. Leave/removal/logout/socket disconnect stop voice and release media resources.
- One send/receive transceiver per peer and stable attached audio elements prevent conflicting negotiation/playback paths. Automatic gain control is off, noise reduction is optional and echo cancellation remains enabled.
- Local speech detection changes only the activity indicator. It never gates audio or flips the microphone between words. Separate activity thresholds and a hold interval reduce flicker.
- Mono capture, bounded sender bitrate, a supported-browser jitter-buffer hint and bounded ICE restart handle transport continuity without continuous server audio processing.
- Voice details expose aggregate loss, jitter, RTT, concealment and direct/relay routing while opened. Copy report excludes candidate addresses, SDP and credentials.
- Signaling is bounded/rate-limited and authorized to current room/voice sessions. Audio is not recorded or written to PostgreSQL; voice does not reset gameplay AFK status.
- Cloudflare TURN support generates temporary credentials server-side; the provider API token never enters client configuration. Existing TURN REST/shared-secret configuration remains supported. Relay-only mode enables explicit transport diagnosis.
- Corrected Cloudflare credentials passed actual generation and a forced-relay browser test. The selected candidate route used TURN; 40 decoded playback samples had zero silent samples. Synthetic audio does not certify every physical headset or network.

Main code: [VoiceChat.jsx](../../client/src/VoiceChat.jsx), [voice.js](../../server/src/voice.js), [turn.js](../../server/src/turn.js), [voice-transport.js](../../client/src/lib/voice-transport.js), [voice-activity.js](../../client/src/lib/voice-activity.js). Usage/setup: [voice guide](../voice-chat.md).

## 9. Playtest, moderation, privacy and operations

- Invite-only playtests require allowed, verified accounts; a separate admissions gate blocks new joins/creation while existing authorized seats can reconnect.
- Hosts can remove another human through an authoritative transition. Cards/turns remain valid; banned account/resume identity cannot rejoin that room. Fresh guest identities remain a limitation, addressed for closed tests by verified invitations.
- Report a problem submits a bounded description and sanitized context. The server verifies actual seat context rather than trusting client match/room claims. Automatic browser error reporting sends fixed redacted codes, not stacks or private state.
- Private bearer-protected operator metrics/reports support triage. Production logs use sampled aggregate diagnostics; public development debugging remains disabled in production.
- Privacy information explains stored data and voice behavior. Email-confirmed account deletion revokes sessions, removes account/avatar data and durably queues anonymization of game references. Pending erasure is retried after restart; anonymous historical outcomes remain consistent.
- Signed browser identity supplements proxy-aware account/IP limits; hashing work has bounded concurrency. Production requires separate operator and browser-signing secrets.
- Dependency vulnerabilities identified during review were fixed; production client/server audits reported zero at verification time. Node is constrained to the 24.x release line.
- CI configuration installs dependencies, checks release/migrations, audits, runs unit and isolated PostgreSQL tests, builds and runs browser checks. A new remote CI run has not yet been observed.

Main code: [launch-controls.js](../../server/src/launch-controls.js), [LaunchTools.jsx](../../client/src/LaunchTools.jsx), [auth.js](../../server/src/auth.js), [diagnostics.js](../../server/src/diagnostics.js), [verify.yml](../../.github/workflows/verify.yml).

## Database migrations and configuration

| Migration | Purpose |
| --- | --- |
| `001_durable_games.sql` | Durable rooms/seats, action receipts, official results/statistics and supporting recovery structures |
| `002_leaderboard_index.sql` | Leaderboard query index |
| `003_player_avatars.sql` | Persistent uploaded avatars |
| `004_launch_controls.sql` | Account deletion marker/erasure queue, sanitized reports and daily ranked-pair counters |

All four migrations were exercised on an isolated test database. Migration 004 was not applied to production by this work. Existing account data is preserved; migration files are checksum-verified and must not be edited after application. Private state remains backend-only, but is not application-level encrypted JSON.

Configuration names/defaults are maintained in [server/.env.example](../../server/.env.example). Important rule defaults: grace 10,000 ms, AI allowance three completed rounds, eligible renewal 60,000 ms, AFK threshold three, result/provisional windows 10,000 ms and four cards per play. Pool defaults are game four/auth two; completed-room memory retention is 300,000 ms.

Launch controls include `PLAYTEST_UNRANKED`, `PLAYTEST_INVITE_ONLY`, `PLAYTEST_ALLOWED_EMAILS`, `GAME_ADMISSIONS_OPEN`, `RANKED_REQUIRE_VERIFIED` and `RANKED_PAIR_DAILY_LIMIT`. Render's proposed closed-playtest configuration enables invitations/unranked outcomes and caps rooms at 20; that differs intentionally from general application defaults.

Production requires `OPS_API_TOKEN` and `RATE_IDENTITY_SECRET` of at least 32 characters. Cloudflare uses `VOICE_TURN_PROVIDER=cloudflare`, `CLOUDFLARE_TURN_KEY_ID` and `CLOUDFLARE_TURN_API_TOKEN`; `VOICE_RELAY_ONLY` defaults false. Preserve existing database, origin, OAuth and Resend variables. No secret values belong in version documents or frontend builds.

## Verification record

These are recorded results from the implementation session on 2026-11-13, not tests rerun merely to write this document.

| Command/check | Actual result |
| --- | --- |
| `npm test` | 90 total: 86 passed, four opt-in database tests skipped in this command |
| `npm run test:postgres` | 18 passed on an isolated Neon branch, including restart recovery, ownership loss, transactions, ranking limits and erasure |
| `npm run test:e2e` | 25 passed using isolated ports 4020/5180 |
| Focused launch unit/HTTP checks | Eight passed after final configuration changes |
| `npm run test:turn` | One relay-only browser test passed; actual relay selected, 40 samples / zero silent |
| `npm run build` | Passed, Vite production build |
| `npm run check:release` | Passed source/version/additive migration checks |
| Production client/server dependency audits | Zero reported vulnerabilities at verification time |
| `git diff --check` | Passed; Windows line-ending notices were informational |
| `npm --prefix server run check:deployment` | Backend health, frontend and auth proxy passed read-only checks; live version remained beta.1 |

Tests include malicious card ownership/counts, stale/duplicate actions, simultaneous challenges/finalization, grace/reconnect abuse, three AFK strikes, human/AI ownership races, automatic round advancement, deck-safe removal, real database failure/restarts, token replay, cold-start resync, sanitized payloads, voice permissions/transport, avatar/seating layouts, moderation, reports and account deletion. Existing regression suites remain in place. Dedicated new tests include `launch.test.js`, `launch-http.test.js`, `launch-pg.test.js` and `client/tests/launch.spec.js`.

## Remaining checks and known limits

- No production deployment, destructive migration or database reset was performed. New local environment values do not automatically reach Render.
- Physical-device/headset tests, mobile and different-network voice, production Google consent and actual Resend delivery remain manual release checks.
- Real Render latency, free-tier cold-start duration and regional database performance are not established by local tests. Render may sleep; no artificial keep-alive service was added.
- One authoritative backend process is supported. Planned overlapping deployments require a maintenance/ownership handoff; zero-downtime multi-instance operation is not claimed.
- The CI workflow has been implemented but needs a real hosted run after pushing. A production backup/restore drill remains pending.
- Guest identity bans are evadable with a fresh identity. Rate buckets are process-local, while game receipts and gameplay allowances are durable.
- Browser media policies, shared microphone hardware and restrictive networks can still affect voice. Use two physical devices for final signoff and inspect transport diagnostics when reporting cuts.
- Historical subsystem documents contain verification results from earlier stages. This consolidated record and the release runbook describe the later combined release.

## Deployment handoff

Follow the [closed playtest release runbook](../playtest-release.md) and [deployment guide](../deployment.md): configure backend secrets/invitations, review migrations, arrange a maintenance handoff, apply required migrations deliberately, deploy matching frontend/backend revisions, verify health/auth/recovery and run invited unranked playtests.

Do not roll back into an older build that cannot read current saved matches. Keep Neon data intact, prefer compatible rollback or fixing forward, and make restore decisions explicitly. Production release approval and deployment evidence must be recorded separately when they occur.
