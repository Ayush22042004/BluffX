# BluffX

Realtime multiplayer Bluff variant with selective challenge mechanics.

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

- Player count: 2 to 6
- Host starts game from lobby
- If a player empties hand, next player must pass/call bluff to finalize result

## Game screens and profile

The neon lounge includes Home, My Profile, AI Setup, Create Room, Join Room, Pre-Game Lobby, the live table, round reveals, and final standings.

- Sign in with email or Google, create an account, or continue as a guest. **My Profile** saves account names and avatars to the server; guest profiles and match counters stay in this browser.
- **Play with AI** supports **1?5 AI opponents**. Choose the count and turn duration before creating the table, then press **Start Match**.
- **Create Room** configures a room name, 2?6 total seats, turn duration, and an optional password. Share the generated six-character code. Guests must ready up before the host starts.
- **Show all cards** opens a grid for selecting larger hands; **Fan view** returns to the table layout.
- On a final claim, remaining opponents must pass or challenge; they cannot play over it. All passes or a successful defense ends the game. A caught bluff returns the pile to the claimant.
- Challenges and table passes pause on a round result. The host presses **Next Round** to continue. Timeouts count as passes when a claim is open.
- Final standings show the winner, remaining card counts, rematch, and return to menu.
- Live room chat and a current-table leaderboard are included. Other players' hidden cards stay on the server.
- A lost connection removes the seat. Rooms are held in server memory; restarting the server clears them.

## Checks

```bash
npm test
npm run build
npm run test:e2e
```

The browser tests use Google Chrome through Playwright. They reuse local servers on ports 4000 and 5173 or start them automatically. They cover profile persistence, AI setup, mobile layout, card play, a caught bluff, a final claim, the winner screen, and rematch. Server tests cover game invariants and the live Socket.IO lifecycle.

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
