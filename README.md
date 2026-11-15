# BluffX

Final release checks and deployment handoff: [2026-11-15 audit](docs/versions/v0.3.0-final-audit.md).

Existing Gmail sender setup: [Gmail API over HTTPS](docs/gmail.md).

Current email alternative: [Brevo setup](docs/brevo.md).

Latest voice UI: [clear speaking indicators](docs/versions/v0.3.0-speaking-indicators.md).

Latest UI polish: [voice setup choices](docs/versions/v0.3.0-voice-setup-ui.md).

Latest voice update: [headphone capture continuity](docs/versions/v0.3.0-headphone-capture.md).

Audit fixes and release qualification: [v0.3.0 reliability update](docs/versions/v0.3.0-reliability-fixes.md).

Latest UI update: [table settings dialog](docs/versions/v0.3.0-table-settings.md).

Latest theme update: [original v3 Pink restoration](docs/versions/v0.3.0-original-pink.md).

Theme colors: [coordinated palettes](docs/versions/v0.3.0-theme-palettes.md).

Player appearance settings: [three selectable neon themes](docs/versions/v0.3.0-theme-picker.md).

Latest visual update: [neon blue theme](docs/versions/v0.3.0-neon-blue.md).

Email setup: [Resend and report notifications](docs/resend.md), with the [update record](docs/versions/v0.3.0-resend.md).

Realtime multiplayer Bluff variant with selective challenge mechanics.

## Version history

See the [version history](docs/versions/README.md) and [complete beta version 2 implementation record](docs/versions/beta-v2.md) for implemented features, migrations, verification results, performance measurements and deployment status. Use the [version template](docs/versions/TEMPLATE.md) for each future update.

The current development release is **0.3.0**: ten-human tables, one/two decks, presets, ready-confirmed rematches, friends/invitations, match insights, achievements and history. See the [v0.3.0 implementation record](docs/versions/v0.3.0.md) for verification, optional features excluded, voice cost constraints and pending production migrations. This development release has not been deployed.

## What is unique here

When a player calls bluff, they pick one or more positions from the facedown cards played in the previous move.

- If at least one selected position is fake (does not match declared rank), caller wins and bluffer takes the full pile.
- If every selected position is real, caller loses and takes the full pile.

## Tech Stack

- Client: React + Vite + Tailwind CSS + Socket.IO Client
- Server: Node.js + Express + Socket.IO

## Quick Start

## 1) Install all dependencies

```bash
cd e:\bluff
npm install
npm --prefix server install
npm --prefix client install
```

Before startup, configure an isolated development PostgreSQL database and run `npm run db:migrate-games`. Do not run development against the deployed game database. See [reliability and recovery](docs/reliability-overhaul.md).

## 2) Run both server and client together

```bash
cd e:\bluff
npm run dev
```

## 3) Alternative: run separately

### Server

```bash
cd server
npm install
npm run dev
```

Server runs on `http://localhost:4000`.

### Client

```bash
cd client
npm install
npm run dev
```

Client runs on `http://localhost:5173`.

## Env Variables

### Server

- `PORT` default: `4000`
- `CLIENT_ORIGIN` default: `http://localhost:5173`

### Client

- `VITE_SERVER_URL` default: `http://localhost:4000`

## Anti-Cheat Measures Included

- Server-authoritative game state
- Turn validation on every action
- Card ownership validation before play
- Duplicate action/index checks
- Hidden-card security (clients only get own hand + public counts)

## Notes

- Player count: 2 to 10
- Host starts game from lobby
- If a player empties hand, next player must pass/call bluff to finalize result

## Game screens and profile

The neon lounge includes Home, My Profile, AI Setup, Create Room, Join Room, Pre-Game Lobby, the live table, round reveals, and final standings.

- Sign in with email or Google, create an account, or continue as a guest. **My Profile** saves account names and avatars to the server; guest profile preferences stay in this browser. Official match statistics come from PostgreSQL; guest and practice outcomes are unranked.
- **Play with AI** supports **1?5 AI opponents**. Choose the count and turn duration before creating the table, then press **Start Match**.
- **Create Room** configures a room name, 2?6 total seats, turn duration, and an optional password. Share the generated six-character code. Guests must ready up before the host starts.
- **Show all cards** opens a grid for selecting larger hands; **Fan view** returns to the table layout.
- On a final claim, remaining opponents must pass or challenge; they cannot play over it. All passes or a successful defense ends the game. A caught bluff returns the pile to the claimant.
- Challenges and table passes pause on a round result. The next round starts automatically after ten seconds; the host can press **Next Round** earlier. Timeouts count as passes when a claim is open.
- Final standings show the winner, remaining card counts, rematch, and return to menu.
- Live room chat and a current-table leaderboard are included. Other players' hidden cards stay on the server.
- A lost connection uses a cumulative grace budget, then temporary AI. Rooms, private hands, hashed resume tokens and deadlines recover from PostgreSQL after a restart.

## Checks

```bash
npm test
npm run build
npm run test:e2e
# Explicit isolated TEST_DATABASE_URL and TEST_DATABASE_HOST required:
npm run test:postgres
```

The browser tests use Google Chrome through Playwright and isolated local servers on ports 4020 and 5180. They cover profile persistence, AI setup, mobile layout, card play, a caught bluff, a final claim, the winner screen, rematch, tab recovery and offline/AI notices. Server tests cover game invariants, pause/AI/removal rules, and the live Socket.IO lifecycle.

Artwork assets and generation prompts are documented in [docs/artwork.md](docs/artwork.md).

## Login and email setup

See [docs/authentication.md](docs/authentication.md) for Google OAuth, Resend over HTTPS (for Render), optional SMTP, local email previews, sessions, and deployment settings. Email/password accounts work locally; live Google sign-in and email delivery require your provider configuration. Use Node.js 24.11 or later.

## Playable tutorial

**How to Play ? Play Tutorial Game** opens an eight-step practice game. It teaches card selection, rank claims, passing, bluff challenges, pile penalties, and the final-claim win condition using a small scripted deal. Tutorial play does not create a live room or change match statistics.

Accounts with no tutorial preference see a welcome invitation after signing in, including Google sign-in and restored sessions. Players can start it or skip it. Completion and skipping are saved per account in PostgreSQL, so the invitation does not repeat on subsequent logins. The tutorial remains replayable from How to Play. A live table must be finished or left before starting a tutorial.

## Email on Render

Use `MAIL_PROVIDER=resend`, `RESEND_API_KEY`, and a verified `MAIL_FROM` sender in the backend's Render environment. Verification/reset emails go through HTTPS rather than SMTP. Set `APP_ORIGIN` to your deployed frontend URL. See [the deployment guide](docs/authentication.md) for the environment variables and the Neon PostgreSQL connection settings.

## Deployment

Deploy the frontend to Vercel and the backend to Render using [docs/deployment.md](docs/deployment.md). Account data is stored in Neon PostgreSQL.

## Previous release 0.2.0

Loading, login, and gameplay use the production interface without prerelease banners. Offline players get a ten-second reconnect pause, then AI can control their seat for three completed rounds before removal. Returning restores the same seat and current hand. See [the current rules](docs/gameplay-beta.md), [responsive UI verification](docs/ui-audit.md), and [durability, security, tests, and deployment procedure](docs/reliability-overhaul.md).


## AFK and performance in beta.2

Connected players receive two AFK warnings, then temporary AI after a third missed eligible turn. **I'm Back ? Take Control** restores the current hand without resetting time. Disconnecting during AI control preserves its remaining allowance. Existing offline grace, round counting, deck conservation, results and secure reconnect rules remain covered by regression tests.

See [the measured beta.2 report](docs/beta2-performance.md) for baseline/optimized latency, SQL calls, Socket.IO bytes, memory, test coverage and safe release steps. `npm run test:load` runs a local simulated-persistence load check; add `-- --postgres --rooms 3 --rounds 2` only with explicit isolated test-database configuration. `npm --prefix server run check:deployment` is now read-only by default and does not create live matches or accounts. No production deployment is automatic.
