# BluffX beta 0.2.0-beta.1

## Offline player rules

1. A dropped connection retains the player's identity, hand, and seat. The whole table sees an offline notice and the turn clock freezes for up to 10 seconds. Returning within that window resumes the exact unused turn time.
2. After the grace window, the table clearly announces that AI is playing for that player. It controls the same hand for up to three completed game rounds. A round is the existing claim/reveal cycle ending when everyone passes or a challenge resolves, not an individual turn. The current round counts if it completes after takeover starts.
3. Returning before expiry immediately restores human control; no new hand is dealt. Guest seats can recover after a tab closes using a private browser resume token. Signed-in seats also require the same authenticated account. A second tab takes control rather than duplicating the seat; the old tab is disconnected and notified.
4. After the third completed round, an absent player is removed. A four-player table becomes three players. If only one player remains, they win. Removed hands are retired into the discard rather than added to another player's penalty; all 52 cards remain accounted for.
5. Host ownership transfers to an online human if the host drops. If all humans are offline, AI can continue result screens automatically. Empty/fully abandoned finished rooms are cleaned up. Explicitly leaving, logging out, or revoking a session leaves immediately rather than requesting reconnect grace.

Clean tab closure can be detected promptly. Abrupt power or network loss cannot be instantaneous: the heartbeat may take up to roughly eight seconds to detect it, then the ten-second grace begins. Every simultaneously offline player gets a grace deadline; the table resumes when all current grace windows have ended or those players return.

The initial HTML loading screen, account loading screen, and top release strip identify the game as beta. The top strip shows `v0.2.0-beta.1` on login and gameplay screens. AI control, rounds remaining, and offline status are visible at the table and in player lists/history.

## Verification

- `npm test`: game/deck invariants; exact pause/resume budgets; simultaneous disconnects; three-round removal; two-player last-player victory; safe turn-index changes; private resume data; real socket reconnection/token rotation and ten-second AI takeover.
- `npm run test:e2e`: authentication, mobile/table layout, game outcomes, tutorials, beta/version label, reload/closed-tab hand recovery, and visible offline/AI/reconnect notices. Browser tests use isolated ports 4020/5180 rather than the user's development server.
- Production acceptance: `npm --prefix server run check:deployment` checks real sign-in, first-party cookie restoration, and an authenticated game. The offline protocol also requires the Render backend to deploy this release, not just the Vercel frontend.

## Remaining game-logic priorities

These are observed limitations or rules still to decide, not features included in this release.

| Priority | Current gap | Recommended change |
| --- | --- | --- |
| 1 | `rooms` and resume tokens are held in server memory; a Render restart/deployment loses an active match even though Neon accounts survive. | Persist private room snapshots, seats, resume-token hashes, and turn deadlines; restore them on startup before accepting reconnects. |
| 2 | Match counters/leaderboard records remain in browser storage and can be edited or diverge across devices. Reconnects now avoid counting the same result twice in that browser, but this is not an authoritative leaderboard. | Record match outcomes once in PostgreSQL using a unique match/player key; include forfeits and AI takeover in the result. |
| 3 | Repeated disconnect/reconnect cycles can repeatedly request a fresh grace window or reset the three-round AI allowance. | Bound grace per player per round and require a stable reconnect period before renewing the AI allowance. |
| 4 | A player who is connected but never acts can keep timing out; network presence alone does not detect AFK play. | Count consecutive missed turns, warn the player, then apply an AI/forfeit policy after a defined strike limit. |
| 5 | An online but AFK host can leave everyone stuck on a round-result screen because only the host advances it. | Auto-start the next round after a visible 8–10 second result countdown; allow the host to advance earlier. |
| 6 | A play can claim any number of cards, including an entire hand. Only challenges currently have an optional claim timestamp; delayed pass/play events can target a newer situation if the same player has the turn again. | Decide the maximum cards per play (often 1–4 for a single-deck game), enforce it server-side, and require match/turn/claim sequence numbers on every game action. |
| 7 | A temporary AI can currently win on behalf of its absent player before the three-round allowance expires. | Decide whether such a win counts, is a forfeit, or requires the player to return before results are awarded. Explain the chosen policy before joining. |
| 8 | Socket chat has throttling, but game/setup events do not have a general burst limit. | Add per-connection action limits and duplicate-event acknowledgement so repeated clicks or automated spam cannot flood room updates/database session checks. |

Implement durable active-match recovery and authoritative results before adding ranked play. Then address AFK/grace abuse, round auto-advance, and action sequencing.
