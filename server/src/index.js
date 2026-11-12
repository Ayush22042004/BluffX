require("./environment").loadEnvironment();
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const crypto = require("crypto");
const { createAuth } = require("./auth");
const {
  online,
  markOffline,
  markOnline,
  removePlayer,
  tickPresence,
} = require("./presence");
const seatId = (socket) => socket.data.playerId || socket.id;
const tokenHash = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");
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
        ) {
          leave(socket);
          socket.disconnect(true);
        }
      }
    },
  });
  app.use("/auth", auth.router);
  app.get("/health", (_, res) =>
    res.json({ ok: true, version: require("../package.json").version }),
  );
  app.get("/", (_, res) =>
    res.send("BluffX server is running. Open http://localhost:5173 to play."),
  );
  const server = http.createServer(app),
    io = new Server(server, {
      cors: { origin, credentials: true },
      allowRequest: (req, callback) => origin(req.headers.origin, callback),
      pingInterval: 4000,
      pingTimeout: 4000,
    }),
    rooms = new Map();
  const seatTokens = new Map();
  const BOT_NAMES = ["Neel", "Priya", "Rohan", "Meera", "Kabir"];
  const emitError = (socket, error) =>
    socket.emit("action_error", { message: error.message || String(error) });
  function broadcast(room) {
    for (const player of room.players)
      if (!player.isBot && player.socketId)
        io.to(player.socketId).emit("room_state", publicState(room, player.id));
  }
  function releaseSeat(room, player) {
    if (player.resumeHash) seatTokens.delete(player.resumeHash);
    const socket = io.sockets.sockets.get(player.socketId);
    if (socket) {
      socket.leave(room.id);
      socket.emit("room_removed", {
        message: "You were removed from this table.",
      });
    }
  }
  function processPresence(room) {
    const result = tickPresence(room);
    for (const player of result.removed) releaseSeat(room, player);
    if (room.closed) {
      for (const p of room.players) releaseSeat(room, p);
      clearTimeout(room.botTimer);
      rooms.delete(room.id);
    }
    return result.changed;
  }
  function bindSeat(room, socket, player) {
    if (player.resumeHash) seatTokens.delete(player.resumeHash);
    const token = crypto.randomBytes(32).toString("hex");
    Object.assign(player, {
      socketId: socket.id,
      accountId: socket.data.accountId || null,
      connected: true,
      resumeHash: tokenHash(token),
    });
    socket.data.playerId = player.id;
    seatTokens.set(player.resumeHash, { roomId: room.id, playerId: player.id });
    socket.join(room.id);
    socket.emit("seat_session", {
      token,
      roomId: room.id,
      guest: !socket.data.accountId,
    });
  }
  function notify(room, event) {
    processPresence(room);
    if (event) io.to(room.id).emit("bluff_result", event);
    broadcast(room);
    scheduleBot(room);
  }
  function scheduleBot(room) {
    clearTimeout(room.botTimer);
    if (room.closed || room.pause) return;
    if (room.phase === "round_result" && !room.players.some(online)) {
      room.botTimer = setTimeout(() => {
        if (
          room.phase === "round_result" &&
          !room.pause &&
          !room.players.some(online)
        ) {
          nextRound(room);
          notify(room);
        }
      }, 4000);
      return;
    }
    if (room.phase !== "playing") return;
    const player = room.players[room.currentTurnIndex];
    if (!player || (!player.isBot && !player.aiTakeover)) return;
    room.botTimer = setTimeout(
      () => {
        if (
          room.phase !== "playing" ||
          room.pause ||
          room.players[room.currentTurnIndex]?.id !== player.id ||
          (!player.isBot && !player.aiTakeover)
        )
          return;
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
      Math.max(
        0,
        Math.min(
          2200 + Math.random() * 1600,
          (room.turnEndsAt || Date.now() + 4000) - Date.now() - 50,
        ),
      ),
    );
  }
  function roomFor(socket, id) {
    const room = rooms.get(String(id || "").toUpperCase());
    if (
      !room ||
      !room.players.some(
        (p) =>
          p.id === seatId(socket) &&
          p.socketId === socket.id &&
          p.connected !== false,
      )
    )
      throw Error("You are not seated in this room.");
    return room;
  }
  function assertUnseated(socket) {
    if (
      [...rooms.values()].some((r) =>
        r.players.some(
          (p) =>
            p.id === seatId(socket) ||
            (socket.data.accountId && p.accountId === socket.data.accountId),
        ),
      )
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
      const player = room.players.find(
        (p) => p.id === seatId(socket) && p.socketId === socket.id,
      );
      if (!player) continue;
      socket.leave(room.id);
      removePlayer(room, player.id);
      if (player.resumeHash) seatTokens.delete(player.resumeHash);
      if (room.closed) {
        rooms.delete(room.id);
        clearTimeout(room.botTimer);
      } else {
        broadcast(room);
        scheduleBot(room);
      }
    }
    socket.emit("room_left");
  }
  function disconnect(socket) {
    if (socket.data.replaced) return;
    for (const room of rooms.values()) {
      const player = room.players.find(
        (p) => p.id === seatId(socket) && p.socketId === socket.id,
      );
      if (!player) continue;
      if (markOffline(room, player.id)) {
        player.socketId = null;
        broadcast(room);
        scheduleBot(room);
      }
    }
  }
  function resumeSeat(socket) {
    const raw = socket.handshake.auth?.resumeToken;
    const saved =
      typeof raw === "string" && /^[a-f0-9]{64}$/.test(raw)
        ? seatTokens.get(tokenHash(raw))
        : null;
    let room = saved && rooms.get(saved.roomId);
    let player = room?.players.find((p) => p.id === saved.playerId);
    if (!player && socket.data.accountId) {
      room = [...rooms.values()].find((r) =>
        r.players.some(
          (p) => p.accountId === socket.data.accountId && p.connected === false,
        ),
      );
      player = room?.players.find(
        (p) => p.accountId === socket.data.accountId && p.connected === false,
      );
    }
    if (
      !player ||
      (player.accountId || null) !== (socket.data.accountId || null)
    ) {
      if (raw)
        socket.emit("seat_expired", {
          message: "Your previous table is no longer available.",
        });
      return;
    }
    processPresence(room);
    if (!room.players.includes(player) || room.closed) {
      socket.emit("seat_expired", { message: "Your offline seat expired." });
      return;
    }
    const previous = io.sockets.sockets.get(player.socketId);
    if (previous && previous.id !== socket.id) {
      previous.data.replaced = true;
      previous.emit("seat_replaced", {
        message: "Your seat was opened in another tab.",
      });
      previous.disconnect(true);
    }
    markOnline(room, player.id);
    bindSeat(room, socket, player);
    broadcast(room);
    scheduleBot(room);
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
    resumeSeat(socket);
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
        hostId: seatId(socket),
        roomName: String(data.roomName || `${name}'s Bluff Arena`)
          .trim()
          .slice(0, 32),
        phase: "lobby",
        players: [
          {
            id: seatId(socket),
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
      bindSeat(room, socket, room.players[0]);
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
        id: seatId(socket),
        name: nameFor(d.name),
        avatar: avatarFor(d.avatar),
        ready: false,
        isBot: false,
      });
      bindSeat(room, socket, room.players.at(-1));
      broadcast(room);
    });
    on("set_ready", (d) => {
      const room = roomFor(socket, d.roomId);
      if (room.phase !== "lobby") throw Error("The match has already started.");
      room.players.find((p) => p.id === seatId(socket)).ready = Boolean(
        d.ready,
      );
      broadcast(room);
    });
    for (const event of ["start_game", "restart_game"])
      on(event, (d) => {
        const room = roomFor(socket, d.roomId);
        if (room.hostId !== seatId(socket))
          throw Error("Only the host can deal.");
        if (event === "start_game" && room.phase !== "lobby")
          throw Error("This match has already started.");
        if (event === "restart_game" && room.phase !== "finished")
          throw Error("Finish this match before starting a rematch.");
        if (
          room.pause ||
          room.players.some((p) => !p.isBot && p.connected === false)
        )
          throw Error(
            "Wait for offline players to reconnect or leave the table.",
          );
        if (room.players.length < 2)
          throw Error("At least two players are needed.");
        if (event === "start_game" && room.players.some((p) => !p.ready))
          throw Error("Wait for every player to ready up.");
        startGame(room, createDeck());
        notify(room);
      });
    on("play_cards", (d) => {
      const room = roomFor(socket, d.roomId);
      notify(room, applyPlay(room, seatId(socket), d.cardIds, d.declaredRank));
    });
    on("pass_bluff", (d) => {
      const room = roomFor(socket, d.roomId);
      notify(room, applyPass(room, seatId(socket)));
    });
    on("call_bluff", (d) => {
      const room = roomFor(socket, d.roomId);
      if (d.claimTs !== undefined && d.claimTs !== room.lastMove?.ts)
        throw Error("That claim has closed. Review the latest move.");
      notify(room, applyChallenge(room, seatId(socket), d.selectedIndexes));
    });
    on("continue_round", (d) => {
      const room = roomFor(socket, d.roomId);
      if (seatId(socket) !== room.hostId)
        throw Error("The host starts the next round.");
      if (room.pause) throw Error("The table is paused for a reconnect.");
      if (room.phase !== "round_result")
        throw Error("There is no round result to continue.");
      nextRound(room);
      notify(room);
    });
    on("update_profile", (d) => {
      const name = nameFor(d.name),
        avatar = avatarFor(d.avatar);
      for (const room of rooms.values()) {
        const player = room.players.find((p) => p.id === seatId(socket));
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
      const p = room.players.find((p) => p.id === seatId(socket));
      io.to(room.id).emit("chat_message", {
        id: crypto.randomUUID(),
        name: p.name,
        avatar: p.avatar,
        text: d.text.trim().slice(0, 280),
        ts: now,
      });
    });
    socket.on("disconnect", () => disconnect(socket));
  });
  const timer = setInterval(() => {
    for (const room of [...rooms.values()]) {
      if (processPresence(room)) {
        broadcast(room);
        scheduleBot(room);
      }
      if (room.closed) continue;
      if (
        room.phase === "playing" &&
        !room.pause &&
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
    }
  }, 250);
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
