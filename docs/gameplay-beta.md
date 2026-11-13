# BluffX 0.2.0 — Gameplay rules

## Offline player rules

1. A dropped connection retains the player's identity, hand, and seat. The whole table sees an offline notice and the turn clock freezes for up to 10 seconds. Returning within that window resumes the exact unused turn time.
2. After the grace window, the table clearly announces that AI is playing for that player. It controls the same hand for up to three completed game rounds. A round is the existing claim/reveal cycle ending when everyone passes or a challenge resolves, not an individual turn. The current round counts if it completes after takeover starts.
3. Returning before expiry immediately restores human control; no new hand is dealt. Guest seats can recover after a tab closes using a private browser resume token. Signed-in seats also require the same authenticated account. A second tab takes control rather than duplicating the seat; the old tab is disconnected and notified.
4. After the third completed round, an absent player is removed. A four-player table becomes three players. If only one player remains, they win. Removed hands are retired into the discard rather than added to another player's penalty; all 52 cards remain accounted for.
5. Host ownership transfers to an online human if the host drops. Round results advance automatically after ten seconds even if all humans are offline. Empty/fully abandoned finished rooms are cleaned up. Explicitly leaving, logging out, or revoking a session leaves immediately rather than requesting reconnect grace.

Clean tab closure can be detected promptly. Abrupt power or network loss cannot be instantaneous: the heartbeat may take up to roughly eight seconds to detect it, then the ten-second grace begins. Every simultaneously offline player gets a grace deadline; the table resumes when all current grace windows have ended or those players return.

Loading, login, and gameplay use production branding without a prerelease strip. AI control, rounds remaining, and offline status are visible at the table and in player lists/history.

## Verification

- `npm test`: game/deck invariants; exact pause/resume budgets; simultaneous disconnects; three-round removal; two-player last-player victory; safe turn-index changes; private resume data; real socket reconnection/token rotation and ten-second AI takeover.
- `npm run test:e2e`: authentication, responsive layouts, game outcomes, tutorials, production branding, reload/closed-tab hand recovery, and visible offline/AI/reconnect notices. Browser tests use isolated ports 4020/5180 rather than the user's development server.
- Production acceptance: `npm --prefix server run check:deployment` checks real sign-in, first-party cookie restoration, and an authenticated game. The offline protocol also requires the Render backend to deploy this release, not just the Vercel frontend.

## Reliability overhaul

The eight limitations previously listed here are implemented in the working reliability release: durable snapshots/recovery, official results/statistics, cumulative grace and persistent AI allowances, AFK enforcement, automatic result advancement, sequenced/idempotent four-card plays, provisional AI victories, and event rate limits.

See [the implementation report](reliability-overhaul.md) for the exact rules, tests, configuration, remaining limitations and required migration/maintenance steps. This release has not been deployed to production automatically.

Reconnect grace is now **cumulative per round**, not a fresh ten seconds on every disconnect. AI allowances renew only after sixty continuously connected seconds with meaningful gameplay activity. Three consecutive missed turns trigger AI control or forfeit. Human gameplay actions clear strikes; merely reclaiming control does not. Round results advance automatically after ten seconds even if the host is AFK.

Absent/AI-controlled winners enter a ten-second provisional window. Returning confirms an explicitly unranked assisted win; expiry forfeits the seat. Competitive statistics require a match with at least two signed-in humans, no practice bots and a winner without AI assistance. Legacy browser scores do not count.

## AFK control in beta.2

Connected players who miss eligible turns receive Possibly AFK on the first miss, Final Warning on the second, and temporary AI on the third. There is no AFK grace pause. Only a legal human play, pass or challenge clears strikes. Chat, focus, reconnection and AI moves do not.

Use **I'm Back ? Take Control** while connected to reclaim your current hand. Reclaim never restarts the running turn clock or undoes AI moves. AI and reclaim are serialized by the authoritative room queue. If you disconnect while AFK AI is controlling your seat, that controller and its already-consumed three-round allowance continue; no second grace period is created. A valid offline reconnection restores control under the existing offline protocol. Opening another tab while still connected does not silently cancel AFK AI.

At the same server timestamp, an already-expired eligible turn resolves before the disconnect transition. One expired turn produces one strike. A disconnect detected before its deadline freezes only its genuine remaining time. AI-controlled seats that do not recover before three completed rounds forfeit even if their socket remains connected.

Completed tables close after five minutes by default; official results remain durable in Neon. No paid AI engine is used. See [the beta.2 performance and implementation report](beta2-performance.md) for measurements, compatibility, configuration and deployment.
