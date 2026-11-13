# Production UI review — 0.2.0

The existing neon design is preserved. The public beta strip, beta warnings on initial/account loading screens, and raw developer instructions in the error screen have been removed. Workspace, client and server package versions are now `0.2.0`. This version change does not alter database schemas or stored game state. No production deployment was performed.

## Layout repairs

- Sidebar cards size to their content. Lobby chat no longer claims 100% of the sidebar and compresses Table Voice. Voice controls and member volumes remain inside the card while connected.
- Lobby heading, table, local player, game facts, and action buttons follow document flow. The long rule summary moves behind View table rules; all gameplay rules remain available in How to Play. Space is reserved for the top opponent without covering the heading.
- Clockwise seats are clamped within the table at tablet widths. Decorative opponent card backs no longer overlap adjacent seats or the local hand. Show all cards sits with the hand controls instead of covering an opponent. Expanded cards use an opaque surface.
- Tablet voice spans the sidebar grid; phone voice appears above history/chat. Scrolling feeds retain accessible input controls. Dialogs fit the available viewport with internal scrolling. Long names and voice status text wrap or truncate within their containers.
- Phone navigation has explicit accessible labels, including Play and Create Room. Leaderboard remains accessible on phones alongside the other navigation controls.

## Measured checks

The browser layout audit exercises home, guest profile, room setup, leaderboard, instructions, lobby, six-seat gameplay, and login at **360, 390, 768, 1024, 1366, and 1920 px**. It additionally checks signed-in profile settings at 390/768/1366 px and connected voice controls at 390/1024/1366 px. Screenshot artifacts are written under `client/tests/artifacts/ui-*.png`.

Before the repairs, the lobby voice card at 1024 px had **82 px** of content height available for **165 px** of content; at 1366 px it had **110 px** for **142 px**. Tablet gameplay also overflowed horizontally by **3 px**. Afterward, the audited views have **zero horizontal overflow and zero clipped cards**; sidebar cards do not intersect. Voice cards grow to their required height.

Regression coverage remains in `client/tests/ui-layout.spec.js`, `client/tests/voice.spec.js`, and `client/tests/reconnect.spec.js`. Other browser tests cover live play, card picking, challenge outcomes, rematches, tutorials, AFK and reconnect. The checks use isolated ports 4020/5180 and do not modify production data. Chrome emulation does not replace testing physical iOS/Android devices or every browser/text-scale combination.

Verification: `npm run test:e2e` passed all **21** browser tests; `npm test` passed **74** server tests with two database-only suites skipped in that mode; `npm run build` passed. Visual review also covered rank selection and round-result screenshots. The redundant arena heading is hidden during round results so the top player seat does not cover it.

## Release

Build and release the updated client and backend through the normal deployment procedure. There is no new UI migration or environment variable. Existing pending game/avatar migrations still need their own reviewed release procedure. The Vercel frontend and Render backend have not been pushed or deployed automatically.
