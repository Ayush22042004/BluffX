require("./environment").loadEnvironment();
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const crypto = require("crypto");
const { createAuth } = require("./auth");
const {
  createDeck,
  applyPlay,
  applyPass,
  applyChallenge,
  publicState,
  nextRound,
  startGame,
  finishGame,
} = require("./game");
async function main() {
  const PORT = process.env.PORT || 4000;
  const production = process.env.NODE_ENV === "production";
  const allowed = new Set(
    [
      ...(!production
        ? [
            "http://localhost:5173",
            "http://127.0.0.1:5173",
            "http://localhost:4173",
            "http://127.0.0.1:4173",
          ]
        : []),
      ...(process.env.CLIENT_ORIGIN || "").split(","),
    ]
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const origin = (value, cb) => {
    let local = false;
    try {
      local =
        /^(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(
          new URL(value).hostname,
        );
    } catch {}
    cb(null, !value || allowed.has(value) || (!production && local));
  };
  const app = express();
  if (process.env.RENDER === "true") app.set("trust proxy", 1);
  app.use(cors({ origin, credentials: true }));
  const auth = await createAuth({
    allowedOrigins: allowed,
    onRevoke: (id, hash) => {
      for (const socket of io.sockets.sockets.values()) {
        if (
          socket.data.accountId === id &&
          (!hash || socket.data.sessionHash === hash)
        )
          socket.disconnect(true);
      }
    },
  });
  app.use("/auth", auth.router);
  app.get("/health", (_, res) => res.json({ ok: true }));
  app.get("/", (_, res) =>
    res.send("BluffX server is running. Open http://localhost:5173 to play."),
  );
  const server = http.createServer(app),
    io = new Server(server, {
      cors: { origin, credentials: true },
      allowRequest: (req, callback) => origin(req.headers.origin, callback),
    }),
    rooms = new Map();
  const BOT_NAMES = ["Neel", "Priya", "Rohan", "Meera", "Kabir"];
  const emitError = (socket, error) =>
    socket.emit("action_error", { message: error.message || String(error) });
  function broadcast(room) {
    for (const player of room.players)
      if (!player.isBot)
        io.to(player.id).emit("room_state", publicState(room, player.id));
  }
  function notify(room, event) {
    if (event) io.to(room.id).emit("bluff_result", event);
    broadcast(room);
    scheduleBot(room);
  }
  function scheduleBot(room) {
    clearTimeout(room.botTimer);
    if (room.phase !== "playing") return;
    const player = room.players[room.currentTurnIndex];
    if (!player?.isBot) return;
    room.botTimer = setTimeout(
      () => {
        if (room.phase !== "playing") return;
        try {
          const hand = room.hands[player.id],
            claim = room.lastMove;
          let result;
          if (claim && (room.pendingWinnerId || Math.random() < 0.24)) {
            if (Math.random() < 0.45) {
              const indexes = claim.cards
                .map((_, i) => i)
                .sort(() => Math.random() - 0.5)
                .slice(0, Math.max(1, Math.floor(claim.cards.length / 2)));
              result = applyChallenge(room, player.id, indexes);
            } else result = applyPass(room, player.id);
          } else {
            const matching = hand.filter((c) => c.rank === room.roundRank);
            if (claim && !matching.length && Math.random() < 0.65)
              result = applyPass(room, player.id);
            else {
              const truthful = Math.random() < 0.68;
              const pool =
                room.roundRank && truthful && matching.length ? matching : hand;
              const count = Math.min(
                pool.length,
                1 + Math.floor(Math.random() * 3),
              );
              const chosen = pool.slice(0, count);
              const rank = room.roundRank || chosen[0].rank;
              result = applyPlay(
                room,
                player.id,
                chosen.map((c) => c.id),
                rank,
              );
            }
          }
          notify(room, result);
        } catch (error) {
          console.error("Bot action failed:", error);
        }
      },
      2200 + Math.random() * 1600,
    );
  }
  function roomFor(socket, id) {
    const room = rooms.get(String(id || "").toUpperCase());
    if (!room || !room.players.some((p) => p.id === socket.id))
      throw Error("You are not seated in this room.");
    return room;
  }
  function assertUnseated(socket) {
    if (
      [...rooms.values()].some((r) => r.players.some((p) => p.id === socket.id))
    )
      throw Error("Leave your current table before joining another.");
  }
  function nameFor(name) {
    if (typeof name !== "string" || !name.trim())
      throw Error("Choose a player name first.");
    return name.trim().slice(0, 20);
  }
  function avatarFor(value) {
    return Number.isInteger(value) && value >= 0 && value < 6 ? value : 0;
  }
  function leave(socket) {
    for (const room of [...rooms.values()]) {
      const index = room.players.findIndex((p) => p.id === socket.id);
      if (index < 0) continue;
      const activeId = room.players[room.currentTurnIndex]?.id;
      socket.leave(room.id);
      clearTimeout(room.botTimer);
      if (!room.players.some((p) => !p.isBot && p.id !== socket.id)) {
        rooms.delete(room.id);
        continue;
      }
      room.pile.push(...(room.hands[socket.id] || []));
      delete room.hands[socket.id];
      room.players.splice(index, 1);
      if (room.hostId === socket.id)
        room.hostId = room.players.find((p) => !p.isBot).id;
      room.currentTurnIndex = Math.max(
        0,
        room.players.findIndex((p) => p.id === activeId),
      );
      if (room.phase === "playing" || room.phase === "round_result") {
        // A departure closes the current claim rather than leaving invalid turn references.
        room.lastMove = null;
        room.pendingWinnerId = null;
        room.roundRank = null;
        room.phase = "playing";
        room.turnEndsAt = Date.now() + room.turnSeconds * 1000;
        const empty = room.players.find((p) => room.hands[p.id].length === 0);
        if (empty || room.players.length === 1)
          finishGame(room, (empty || room.players[0]).id);
      }
      broadcast(room);
      scheduleBot(room);
    }
    socket.emit("room_left");
  }
  io.use(async (socket, next) => {
    try {
      const session = await auth.sessionFromCookie(
        socket.handshake.headers.cookie,
      );
      if (session) {
        socket.data.accountId = session.user.id;
        socket.data.sessionHash = session.hash;
      }
      next();
    } catch {
      next(new Error("Account storage is unavailable. Try again shortly."));
    }
  });
  io.on("connection", (socket) => {
    const on = (name, handler) =>
      socket.on(name, async (data = {}) => {
        try {
          if (socket.data.accountId) {
            const session = await auth.sessionFromCookie(
              socket.handshake.headers.cookie,
            );
            if (!session)
              throw Error("Your session expired. Please sign in again.");
            if (
              [
                "create_room",
                "create_ai_room",
                "join_room",
                "update_profile",
              ].includes(name)
            ) {
              data = {
                ...data,
                name: session.user.name,
                avatar: session.user.avatar,
              };
            }
          }
          handler(data);
        } catch (error) {
          emitError(socket, error);
        }
      });
    function create(data, ai) {
      assertUnseated(socket);
      const name = nameFor(data.name);
      const botCount = data.botCount === undefined ? 3 : data.botCount;
      if (ai && (!Number.isInteger(botCount) || botCount < 1 || botCount > 5))
        throw Error("Choose between 1 and 5 AI opponents.");
      const maxPlayers = ai ? botCount + 1 : Number(data.maxPlayers || 6);
      if (!Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > 6)
        throw Error("Choose 2 to 6 seats.");
      const turnSeconds = Number(data.turnSeconds || 30);
      if (![20, 30, 45, 60].includes(turnSeconds))
        throw Error("Invalid turn duration.");
      let id;
      do {
        id = crypto.randomBytes(3).toString("hex").toUpperCase();
      } while (rooms.has(id));
      const room = {
        id,
        hostId: socket.id,
        roomName: String(data.roomName || `${name}'s Bluff Arena`)
          .trim()
          .slice(0, 32),
        phase: "lobby",
        players: [
          {
            id: socket.id,
            name,
            avatar: avatarFor(data.avatar),
            ready: true,
            isBot: false,
          },
        ],
        hands: {},
        pile: [],
        discard: [],
        lastMove: null,
        roundRank: null,
        roundNumber: 1,
        currentTurnIndex: 0,
        turnEndsAt: null,
        pendingWinnerId: null,
        winnerId: null,
        mode: ai ? "ai" : "multiplayer",
        maxPlayers,
        turnSeconds,
        password:
          typeof data.password === "string" ? data.password.slice(0, 64) : "",
        botTimer: null,
        lastResult: null,
      };
      if (ai)
        for (let i = 0; i < botCount; i++)
          room.players.push({
            id: `BOT_${crypto.randomUUID()}`,
            name: BOT_NAMES[i],
            avatar: [0, 1, 2, 3, 4][i],
            isBot: true,
            ready: true,
          });
      rooms.set(id, room);
      socket.join(id);
      broadcast(room);
    }
    on("create_room", (d) => create(d, false));
    on("create_ai_room", (d) => create(d, true));
    on("join_room", (d) => {
      assertUnseated(socket);
      const room = rooms.get(
        String(d.roomId || "")
          .trim()
          .toUpperCase(),
      );
      if (!room) throw Error("Room not found. Check the code.");
      if (room.mode === "ai") throw Error("This is an AI practice table.");
      if (room.phase !== "lobby")
        throw Error("This match has already started.");
      if (room.players.length >= room.maxPlayers)
        throw Error("This table is full.");
      if (room.password && d.password !== room.password)
        throw Error("Incorrect room password.");
      room.players.push({
        id: socket.id,
        name: nameFor(d.name),
        avatar: avatarFor(d.avatar),
        ready: false,
        isBot: false,
      });
      socket.join(room.id);
      broadcast(room);
    });
    on("set_ready", (d) => {
      const room = roomFor(socket, d.roomId);
      if (room.phase !== "lobby") throw Error("The match has already started.");
      room.players.find((p) => p.id === socket.id).ready = Boolean(d.ready);
      broadcast(room);
    });
    for (const event of ["start_game", "restart_game"])
      on(event, (d) => {
        const room = roomFor(socket, d.roomId);
        if (room.hostId !== socket.id) throw Error("Only the host can deal.");
        if (event === "start_game" && room.phase !== "lobby")
          throw Error("This match has already started.");
        if (event === "restart_game" && room.phase !== "finished")
          throw Error("Finish this match before starting a rematch.");
        if (room.players.length < 2)
          throw Error("At least two players are needed.");
        if (event === "start_game" && room.players.some((p) => !p.ready))
          throw Error("Wait for every player to ready up.");
        startGame(room, createDeck());
        notify(room);
      });
    on("play_cards", (d) => {
      const room = roomFor(socket, d.roomId);
      notify(room, applyPlay(room, socket.id, d.cardIds, d.declaredRank));
    });
    on("pass_bluff", (d) => {
      const room = roomFor(socket, d.roomId);
      notify(room, applyPass(room, socket.id));
    });
    on("call_bluff", (d) => {
      const room = roomFor(socket, d.roomId);
      if (d.claimTs !== undefined && d.claimTs !== room.lastMove?.ts)
        throw Error("That claim has closed. Review the latest move.");
      notify(room, applyChallenge(room, socket.id, d.selectedIndexes));
    });
    on("continue_round", (d) => {
      const room = roomFor(socket, d.roomId);
      if (socket.id !== room.hostId)
        throw Error("The host starts the next round.");
      if (room.phase !== "round_result")
        throw Error("There is no round result to continue.");
      nextRound(room);
      notify(room);
    });
    on("update_profile", (d) => {
      const name = nameFor(d.name),
        avatar = avatarFor(d.avatar);
      for (const room of rooms.values()) {
        const player = room.players.find((p) => p.id === socket.id);
        if (player) {
          player.name = name;
          player.avatar = avatar;
          broadcast(room);
        }
      }
      socket.emit("profile_saved", { name, avatar });
    });
    on("leave_room", () => leave(socket));
    on("send_chat", (d) => {
      const room = roomFor(socket, d.roomId);
      if (typeof d.text !== "string" || !d.text.trim()) return;
      const now = Date.now();
      if (now - (socket.data.lastChatAt || 0) < 700) return;
      socket.data.lastChatAt = now;
      const p = room.players.find((p) => p.id === socket.id);
      io.to(room.id).emit("chat_message", {
        id: crypto.randomUUID(),
        name: p.name,
        avatar: p.avatar,
        text: d.text.trim().slice(0, 280),
        ts: now,
      });
    });
    socket.on("disconnect", () => leave(socket));
  });
  const timer = setInterval(() => {
    for (const room of rooms.values())
      if (
        room.phase === "playing" &&
        room.turnEndsAt &&
        Date.now() >= room.turnEndsAt
      ) {
        try {
          const player = room.players[room.currentTurnIndex];
          if (room.lastMove) notify(room, applyPass(room, player.id));
          else {
            room.currentTurnIndex =
              (room.currentTurnIndex + 1) % room.players.length;
            room.turnEndsAt = Date.now() + room.turnSeconds * 1000;
            notify(room, {
              type: "pass",
              message: `${player.name} ran out of time. Turn passed automatically.`,
            });
          }
        } catch (error) {
          console.error("Turn timeout:", error);
        }
      }
  }, 500);
  server.listen(PORT, () =>
    console.log(`BluffX server on http://localhost:${PORT}`),
  );
  async function shutdown() {
    clearInterval(timer);
    for (const room of rooms.values()) clearTimeout(room.botTimer);
    io.close();
    server.close();
    await auth.close();
  }
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
main().catch((error) => {
  console.error("Server startup failed:", error.code || error.message);
  process.exit(1);
});
