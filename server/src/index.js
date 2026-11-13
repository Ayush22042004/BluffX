require("./environment").loadEnvironment();
const express = require("express");
const http = require("node:http");
const crypto = require("node:crypto");
const cors = require("cors");
const { Server } = require("socket.io");
const { createAuth } = require("./auth");
const { createGameStore, error } = require("./game-store");
const { RoomService } = require("./room-service");
const { RoomDelivery } = require("./room-delivery");
const { DeadlineScheduler } = require("./deadline-scheduler");
const { Diagnostics } = require("./diagnostics");
const {
  RateLimiter,
  validatePayload,
  fingerprint,
  REQUEST_FP,
} = require("./protocol");
const { RULES } = require("./rules");
const { createVoice } = require("./voice");
const RELEASE = require("../package.json").version;
const BUILD = `${RELEASE}:${(process.env.RENDER_GIT_COMMIT || process.env.BUILD_SHA || "local").slice(0, 40)}`;
const { installLaunch, checkInvitation } = require("./launch-controls");
const MUTATIONS = [
  "set_ready",
  "prepare_rematch",
  "request_rematch",
  "update_settings",
  "start_game",
  "restart_game",
  "play_cards",
  "pass_bluff",
  "call_bluff",
  "continue_round",
  "leave_room",
  "update_profile",
  "reclaim_control",
  "kick_player",
];
function safeError(e, actionId) {
  const safe = [
    "INVALID_",
    "STALE_",
    "NOT_",
    "ACTION_",
    "DUPLICATE_",
    "RATE_",
    "UNAUTHORIZED_",
    "AI_",
    "ROOM_",
    "ALREADY_",
    "INCORRECT_",
    "RESUME_",
    "UNKNOWN_",
  ];
  const known =
    typeof e.code === "string" &&
    safe.some((prefix) => e.code.startsWith(prefix));
  return {
    ok: false,
    actionId,
    code: known
      ? e.code
      : e.code === "VERSION_CONFLICT"
        ? "STALE_TURN"
        : "STORAGE_UNAVAILABLE",
    message: known
      ? e.message
      : e.code === "VERSION_CONFLICT"
        ? "The room changed. Synchronize and retry."
        : "Game storage is temporarily unavailable. Your action could not be confirmed; reconnect before retrying.",
    retryAfterMs: e.retryAfterMs,
  };
}
async function startServer({
  port = Number(process.env.PORT || 4000),
  store: providedStore,
} = {}) {
  const production = process.env.NODE_ENV === "production";
  if (production)
    for (const key of ["OPS_API_TOKEN", "RATE_IDENTITY_SECRET"])
      if ((process.env[key] || "").length < 32)
        throw Error(
          `${key} must contain at least 32 characters in production.`,
        );
  if (
    process.env.PLAYTEST_INVITE_ONLY === "true" &&
    !process.env.PLAYTEST_ALLOWED_EMAILS?.trim()
  )
    throw Error(
      "PLAYTEST_ALLOWED_EMAILS is required for invite-only playtests.",
    );
  const allowed = new Set(
    [
      ...(production
        ? []
        : [
            "http://localhost:5173",
            "http://127.0.0.1:5173",
            "http://localhost:4173",
            "http://127.0.0.1:4173",
          ]),
      ...(process.env.CLIENT_ORIGIN || "").split(","),
    ]
      .map((v) => v.trim())
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
  const server = http.createServer(app),
    io = new Server(server, {
      cors: { origin, credentials: true },
      allowRequest: (req, cb) => origin(req.headers.origin, cb),
      maxHttpBufferSize: RULES.maxPayloadBytes,
      pingInterval: 4000,
      pingTimeout: 4000,
    });
  const limiter = new RateLimiter();
  const metrics = new Diagnostics(
    production || process.env.GAME_DIAGNOSTICS === "true",
  );
  const delivery = new RoomDelivery();
  const storageNotices = new Map();
  let scheduler, voice;
  let requestRecovery;
  const recovery = new Promise((resolve) => {
    requestRecovery = resolve;
  });
  let activeRequests = 0;
  let ready = false,
    stopping = false;
  const store = providedStore || (await createGameStore());
  const service = new RoomService(store, {
    onCommit: (room, effects) => {
      voice?.reconcile(room);
      if (effects.finalized) {
        const ids = new Set(
          (room.participants || []).map((p) => p.accountId).filter(Boolean),
        );
        for (const s of io.sockets.sockets.values())
          if (ids.has(s.data.accountId))
            s.emit("stats_updated", { matchId: room.matchId });
      }
      const prepared = delivery.prepare(room);
      metrics.add(
        "rounds",
        Math.max(
          0,
          (room.completedRounds || 0) -
            (effects.previous?.completedRounds || 0),
        ),
      );
      const members = io.sockets.adapter.rooms.get(room.id);
      for (const socketId of members || []) {
        const socket = io.sockets.sockets.get(socketId);
        if (!socket) continue;
        const p = room.players.find((p) => p.id === socket.data.playerId);
        if (!p || room.closed) {
          socket.leave(room.id);
          socket.data.roomId = null;
          socket.emit("room_removed", {
            message: p
              ? "This completed table has closed."
              : "You left or forfeited this table.",
          });
          continue;
        }
        if (p.controlGeneration !== socket.data.generation) {
          socket.data.replaced = true;
          socket.emit("seat_replaced", {
            message: "Your seat was recovered in another tab.",
          });
          socket.disconnect(true);
          continue;
        }
        delivery.send(socket, room, prepared);
      }
      if (room.closed) {
        storageNotices.delete(room.id);
        delivery.views.delete(room.id);
      }
      if (effects.event) io.to(room.id).emit("bluff_result", effects.event);
    },
  });
  service.metrics = metrics;
  if (metrics.enabled && store.pool) {
    const wrapped = new WeakSet();
    const instrument = (client) => {
      if (wrapped.has(client)) return;
      wrapped.add(client);
      const query = client.query.bind(client);
      client.query = (...args) => {
        metrics.add("sqlCalls");
        return query(...args);
      };
    };
    store.pool._clients.forEach(instrument);
    store.pool.on("connect", instrument);
  }
  let auth;
  try {
    await service.initialize();
    auth = await createAuth({
      allowedOrigins: allowed,
      service,
      notifySocial: (id) => {
        for (const s of io.sockets.sockets.values())
          if (s.data.accountId === id) s.emit("social_updated");
      },
      onErase: (id) => service.eraseAccount(id),
      onRevoke: (id, sessionHash) => {
        for (const socket of io.sockets.sockets.values())
          if (
            socket.data.accountId === id &&
            (!sessionHash || socket.data.sessionHash === sessionHash)
          ) {
            // Session revocation uses a durable disconnect/forfeit, not a client result.
            socket.emit("account_revoked");
            const actor = actorFor(socket);
            const room = service.rooms.get(socket.data.roomId);
            if (room) {
              const { envelope } = require("./protocol");
              service
                .command(room.id, actor, "leave_room", {
                  ...envelope(room),
                  actionId: crypto.randomUUID(),
                })
                .catch(() => {});
            }
            socket.disconnect(true);
          }
      },
    });
  } catch (e) {
    await store.close();
    io.close();
    throw e;
  }
  app.use(
    "/auth",
    (req, res, next) => {
      if (!/^\/(?:social|history|achievements|season)(?:\/|$)/.test(req.path))
        return next();
      try {
        // Bound new read routes before session/database work. Shared proxy IPs get
        // a generous coarse budget; signed browser identities isolate normal use.
        limiter.consume("records:ip:" + req.ip, 300, 5);
        limiter.consume(
          "records:browser:" +
            (auth.rateIdentity(req.headers.cookie) || req.ip),
          30,
          1,
        );
        next();
      } catch (e) {
        res
          .status(429)
          .json({
            code: "RATE_LIMITED",
            message: "Player records are busy. Try again shortly.",
            retryAfterMs: e.retryAfterMs || 1000,
          });
      }
    },
    auth.router,
  );
  require("./history").installHistory({ app, auth, store });
  app.get("/health", (_req, res) =>
    res
      .status(ready && store.available ? 200 : 503)
      .json({ ok: ready && store.available, version: RELEASE, build: BUILD }),
  );
  const endpoint = (fn) => async (req, res) => {
    try {
      limiter.consume("http:" + req.ip, RULES.httpBurst, RULES.httpRefill);
      res.set("Cache-Control", "no-store");
      res.json(await fn(req));
    } catch (e) {
      res.status(e.code === "RATE_LIMITED" ? 429 : e.status || 503).json({
        message: e.status ? e.message : "Statistics temporarily unavailable.",
      });
    }
  };
  app.get(
    "/auth/stats",
    endpoint(async (req) => {
      const session = await auth.sessionFromCookie(req.headers.cookie);
      if (!session)
        throw Object.assign(Error("Please sign in again."), { status: 401 });
      return { stats: await store.stats(session.user.id) };
    }),
  );
  app.get(
    "/auth/leaderboard",
    endpoint((req) => {
      const page = Number(req.query.page || 0),
        limit = Number(req.query.limit || 20);
      if (
        !Number.isInteger(page) ||
        page < 0 ||
        page > 10000 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 50
      )
        throw Object.assign(Error("Invalid pagination."), { status: 400 });
      return store.leaderboard(page, limit);
    }),
  );
  app.get("/", (_req, res) => res.send("BluffX authoritative game server."));
  installLaunch({ app, auth, service, io, metrics, build: BUILD });
  function actorFor(socket) {
    return {
      id: socket.data.playerId,
      accountId: socket.data.accountId || null,
      generation: socket.data.generation,
      proposal: socket.data.proposal,
      profile: socket.data.accountProfile,
    };
  }
  voice = createVoice({ io, service, actorFor, limiter });
  function bind(socket, result) {
    socket.data.playerId = result.seatId;
    socket.data.generation = result.generation;
    socket.data.roomId = result.roomId;
    socket.join(result.roomId);
    socket.emit("seat_session", {
      roomId: result.roomId,
      guest: !socket.data.accountId,
      accepted: true,
    });
    const room = service.rooms.get(result.roomId);
    if (room) delivery.full(socket, room);
  }
  io.use(async (socket, next) => {
    try {
      if (!ready || stopping || !store.available)
        throw Error("Server is recovering. Reconnect shortly.");
      const peer = socket.handshake.address;
      // Match Express's one trusted Render hop. Never accept arbitrary client XFF.
      const forwarded = socket.request.headers["x-forwarded-for"];
      const ip =
        app.get("trust proxy fn")(peer, 0) && typeof forwarded === "string"
          ? forwarded.split(",").at(-1).trim()
          : peer;
      socket.data.rateIp = ip;
      limiter.consume(
        "connectIp:" + ip,
        process.env.RENDER === "true" ? 300 : RULES.connectionBurst,
        process.env.RENDER === "true" ? 10 : 1,
      );
      socket.data.rateIdentity =
        auth.rateIdentity(socket.handshake.headers.cookie) || ip;
      limiter.consume(
        "connect:" + socket.data.rateIdentity,
        RULES.connectionBurst,
        1,
      );
      if (Buffer.byteLength(JSON.stringify(socket.handshake.auth || {})) > 2048)
        throw error("INVALID_PAYLOAD", "Invalid connection details.");
      const session = await auth.sessionFromCookie(
        socket.handshake.headers.cookie,
      );
      if (session) {
        socket.data.accountId = session.user.id;
        socket.data.accountProfile = {
          name: session.user.name,
          avatar: session.user.avatar,
          avatarId: session.user.avatar_id || null,
          emailVerified: Boolean(session.user.email_verified),
        };
        socket.data.sessionHash = session.hash;
      }
      socket.data.playerId = crypto.randomUUID();
      socket.data.generation = 1;
      const proposal = socket.handshake.auth?.nextResumeToken;
      if (!/^[a-f0-9]{64}$/.test(proposal || ""))
        throw error(
          "RESUME_SECRET_REQUIRED",
          "Refresh the app to use the current secure game protocol.",
        );
      socket.data.proposal = proposal;
      next();
    } catch (e) {
      next(
        Object.assign(Error(e.message), {
          data: { code: e.code || "CONNECTION_REJECTED" },
        }),
      );
    }
  });
  io.on("connection", (socket) => {
    if (metrics.enabled)
      socket.onAnyOutgoing((event, ...data) => {
        metrics.add("messages");
        metrics.add(
          "bytes",
          Buffer.byteLength(JSON.stringify([event, ...data])),
        );
      });
    socket.data.initializing = (async () => {
      const token = socket.handshake.auth?.resumeToken,
        pending = socket.handshake.auth?.pendingResumeToken;
      const result = await service.resume(actorFor(socket), [token, pending]);
      if (result) bind(socket, result);
      // A pending proposal alone is normal before this browser has joined a table.
      else if (token)
        socket.emit("seat_expired", {
          message: "Your saved seat expired or its private token was replaced.",
        });
      socket.emit("server_ready", { ready: true });
    })().catch((e) => {
      socket.data.initializationFailed = true;
      socket.emit("action_error", safeError(e));
      socket.disconnect(true);
    });
    const on = (event, handler) =>
      socket.on(event, async (data = {}, ack) => {
        if (stopping) {
          if (typeof ack === "function")
            ack({
              ok: false,
              code: "SERVER_RECOVERING",
              message: "Server is stopping. Reconnect shortly.",
            });
          return;
        }
        activeRequests++;
        const actionStarted = metrics.start();
        try {
          validatePayload(data, event);
          const originalFingerprint = fingerprint(event, data);
          if (!/^[a-zA-Z0-9_-]{8,100}$/.test(data.actionId || ""))
            throw error("INVALID_ACTION", "A unique actionId is required.");
          await socket.data.initializing;
          if (stopping || socket.data.initializationFailed || !socket.connected)
            throw error("UNAUTHORIZED_SEAT", "Connection is no longer active.");
          const roomId = String(data.roomId || socket.data.roomId || "")
            .trim()
            .toUpperCase();
          const cached = service.receipts.get(
            `${roomId}:${socket.data.playerId}:${data.actionId}`,
          );
          if (cached) {
            if (cached.fingerprint !== fingerprint(event, data))
              throw error(
                "DUPLICATE_ACTION",
                "Action ID reused with different data.",
              );
            const response = { ...cached.acknowledgement, duplicate: true };
            if (typeof ack === "function") ack(response);
            else socket.emit("action_ack", response);
            return;
          }
          const cachedSetup = setupReceipts.get(data.actionId);
          if (cachedSetup) {
            if (cachedSetup.fp !== originalFingerprint)
              throw error("DUPLICATE_ACTION", "Action ID reused.");
            const response = { ...cachedSetup.result, duplicate: true };
            if (typeof ack === "function") ack(response);
            else socket.emit("action_ack", response);
            return;
          }
          if (["create_room", "create_ai_room", "join_room"].includes(event))
            limiter.consume(
              "setupIdentity:" +
                (socket.data.accountId || socket.data.rateIdentity),
              RULES.setupBurst,
              RULES.setupRefillPerSec,
            );
          limiter.consume("socket:" + socket.id);
          limiter.consume(
            "identity:" + (socket.data.accountId || socket.data.rateIdentity),
            RULES.identityBurst,
            RULES.identityRefill,
          );
          limiter.consume(
            "event:" + socket.id + ":" + event,
            [
              "create_room",
              "create_ai_room",
              "join_room",
              "restart_game",
            ].includes(event)
              ? RULES.setupBurst
              : RULES.eventTypeBurst,
            [
              "create_room",
              "create_ai_room",
              "join_room",
              "restart_game",
            ].includes(event)
              ? RULES.setupRefillPerSec
              : RULES.eventTypeRefill,
          );
          if (socket.data.accountId) {
            const session = await auth.sessionFromCookie(
              socket.handshake.headers.cookie,
            );
            if (!session || session.user.id !== socket.data.accountId)
              throw error("UNAUTHORIZED_SEAT", "Please sign in again.");
            socket.data.accountProfile.emailVerified = Boolean(
              session.user.email_verified,
            );
            if (
              [
                "create_room",
                "create_ai_room",
                "join_room",
                "update_profile",
              ].includes(event)
            )
              data = {
                ...data,
                name: session.user.name,
                avatar: session.user.avatar,
                avatarId: session.user.avatar_id || null,
              };
          }
          Object.defineProperty(data, REQUEST_FP, {
            value: originalFingerprint,
          });
          if (
            !RULES.admissionsOpen &&
            ["create_room", "create_ai_room", "join_room"].includes(event)
          )
            throw error(
              "ROOM_MAINTENANCE",
              "New tables and joins are temporarily paused. Existing players can reconnect.",
            );
          if (
            process.env.PLAYTEST_INVITE_ONLY === "true" &&
            ["create_room", "create_ai_room", "join_room"].includes(event)
          )
            checkInvitation(
              await auth.sessionFromCookie(socket.handshake.headers.cookie),
            );
          const response = await handler(data, roomId);
          if (typeof ack === "function") ack(response);
          else socket.emit("action_ack", response);
        } catch (e) {
          const response = safeError(e, data?.actionId);
          metrics.add("rejectedActions");
          if (response.code === "STORAGE_UNAVAILABLE")
            metrics.add("storageErrors");
          if (response.code === "STORAGE_UNAVAILABLE")
            socket.emit("storage_status", { available: false });
          socket.emit("action_error", response);
          if (typeof ack === "function") ack(response);
          if (
            ["STALE_TURN", "INVALID_CLAIM", "ACTION_EXPIRED"].includes(
              response.code,
            )
          ) {
            const room = service.rooms.get(socket.data.roomId);
            if (room) delivery.full(socket, room);
          }
        } finally {
          metrics.end("actionMs", actionStarted);
          metrics.add("actions");
          activeRequests--;
        }
      });
    const setupReceipts = new Map();
    on("sync_room", async (data, code) => {
      const room = service.rooms.get(code);
      if (!room) throw error("ROOM_NOT_FOUND", "Table unavailable.");
      service.seat(room, actorFor(socket));
      delivery.full(socket, room);
      return { ok: true, version: room.version };
    });
    for (const event of ["create_room", "create_ai_room"])
      on(event, async (data) => {
        const key = data.actionId,
          fp = fingerprint(event, data),
          prior = setupReceipts.get(key);
        if (prior) {
          if (prior.fp !== fp)
            throw error("DUPLICATE_ACTION", "Setup ID reused.");
          return { ...prior.result, duplicate: true };
        }
        const result = await service.queue(
          "identity:" + (socket.data.accountId || socket.data.playerId),
          () =>
            service.create(actorFor(socket), data, event === "create_ai_room"),
        );
        if (!result.duplicate) bind(socket, result);
        setupReceipts.set(key, { fp, result });
        if (setupReceipts.size > RULES.actionCache)
          setupReceipts.delete(setupReceipts.keys().next().value);
        return result;
      });
    on("join_room", async (data, code) => {
      const result = await service.queue(
        "identity:" + (socket.data.accountId || socket.data.playerId),
        () => service.join(code, actorFor(socket), data),
      );
      if (!result.duplicate) bind(socket, result);
      return result;
    });
    for (const event of MUTATIONS)
      on(event, async (data, code) => {
        if (!socket.data.roomId && event === "update_profile") {
          if (
            typeof data.name !== "string" ||
            !data.name.trim() ||
            !Number.isInteger(data.avatar) ||
            data.avatar < 0 ||
            data.avatar > 5
          )
            throw error("INVALID_PAYLOAD", "Invalid profile.");
          socket.emit("profile_saved", {
            name: data.name.trim().slice(0, 20),
            avatar: data.avatar,
            avatarId: data.avatarId || null,
          });
          return { ok: true, actionId: data.actionId };
        }
        const result = await service.command(
          code,
          actorFor(socket),
          event,
          data,
        );
        if (event === "leave_room" && !result.duplicate) {
          socket.leave(code);
          socket.data.roomId = null;
          socket.emit("room_left");
        }
        return result;
      });
    on("send_chat", async (data, code) => {
      limiter.consume("chat:" + socket.id, RULES.chatBurst, RULES.chatRefill);
      const room = service.rooms.get(code);
      if (!room) throw error("ROOM_NOT_FOUND", "Room not found.");
      const p = service.seat(room, actorFor(socket));
      if (typeof data.text !== "string" || !data.text.trim())
        throw error("INVALID_PAYLOAD", "Empty chat message.");
      io.to(code).emit("chat_message", {
        id: data.actionId,
        name: p.name,
        avatar: p.avatar,
        avatarId: p.avatarId || null,
        text: data.text.trim().slice(0, 280),
        ts: Date.now(),
      });
      const result = { ok: true, actionId: data.actionId };
      setupReceipts.set(data.actionId, {
        fp: fingerprint("send_chat", data),
        result,
      });
      if (setupReceipts.size > RULES.actionCache)
        setupReceipts.delete(setupReceipts.keys().next().value);
      return result;
    });
    socket.onAny((event, data, ack) => {
      if (
        [
          ...MUTATIONS,
          "create_room",
          "create_ai_room",
          "join_room",
          "send_chat",
          "sync_room",
          "voice_join",
          "voice_leave",
          "voice_mute",
          "voice_signal",
        ].includes(event)
      )
        return;
      let response;
      try {
        limiter.consume("socket:" + socket.id);
        response = {
          ok: false,
          code: "UNKNOWN_ACTION",
          message: "Unsupported game event.",
        };
      } catch (e) {
        response = safeError(e);
      }
      socket.emit("action_error", response);
      if (typeof ack === "function") ack(response);
    });
    voice.attach(socket);
    socket.on("disconnect", () => {
      if (!stopping && !socket.data.replaced && socket.data.roomId)
        service
          .disconnect(socket.data.roomId, actorFor(socket))
          .catch(() => {});
      limiter.entries.delete("socket:" + socket.id);
      limiter.entries.delete("chat:" + socket.id);
      for (const event of [
        ...MUTATIONS,
        "create_room",
        "create_ai_room",
        "join_room",
        "send_chat",
        "sync_room",
      ])
        limiter.entries.delete("event:" + socket.id + ":" + event);
      socket.removeAllListeners();
      socket.offAny();
      socket.offAnyOutgoing();
    });
  });
  ready = true;
  scheduler = new DeadlineScheduler((code) => service.wake(code), {
    now: () => service.now(),
    concurrency: RULES.gamePoolSize,
  });
  service.onSchedule = (code, at, available) => {
    scheduler.set(code, store.available ? at : null);
    const before = storageNotices.get(code);
    if (
      (available === false && before !== false) ||
      (available === true && before === false)
    )
      io.to(code).emit("storage_status", { available });
    if (service.rooms.has(code)) storageNotices.set(code, available);
    else storageNotices.delete(code);
  };
  for (const room of service.rooms.values())
    scheduler.set(room.id, room.nextWakeAt);
  store.onUnavailable = () => {
    ready = false;
    io.emit("action_error", {
      ok: false,
      code: "STORAGE_UNAVAILABLE",
      message: "Reconnecting to saved tables after a storage interruption.",
    });
    for (const code of service.rooms.keys())
      service.onSchedule(code, null, false);
    requestRecovery();
  };
  if (!store.available) store.onUnavailable();
  if (!production && metrics.enabled)
    app.get("/debug/metrics", (req, res) => {
      if (
        !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
          req.socket.remoteAddress,
        )
      )
        return res.sendStatus(403);
      res.set("Cache-Control", "no-store").json(
        metrics.report({
          activeRooms: service.rooms.size,
          connectedSockets: io.sockets.sockets.size,
          scheduledRooms: scheduler.heap.length,
          timerHandles: (scheduler.timer ? 1 : 0) + 1,
          schedulerWakeups: scheduler.wakeups,
        }),
      );
    });
  const retention = setInterval(() => store.prune().catch(() => {}), 3600000);
  retention.unref();
  const sampledMetrics = production
    ? setInterval(
        () =>
          console.log(
            JSON.stringify({
              event: "service_metrics",
              build: BUILD,
              ...metrics.report({
                activeRooms: service.rooms.size,
                connectedSockets: io.sockets.sockets.size,
              }),
            }),
          ),
        60000,
      )
    : null;
  sampledMetrics?.unref();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, resolve);
  });
  console.log(`BluffX server on http://localhost:${server.address().port}`);
  async function close() {
    if (stopping) return;
    stopping = true;
    ready = false;
    scheduler.close();
    voice.close();
    metrics.close();
    clearInterval(retention);
    clearInterval(sampledMetrics);
    while (activeRequests)
      await new Promise((resolve) => setTimeout(resolve, 20));
    await service.drain();
    delivery.views.clear();
    storageNotices.clear();
    limiter.entries.clear();
    io.close();
    await new Promise((resolve) => server.close(resolve));
    await auth.close();
    await store.close();
  }
  return {
    app,
    server,
    io,
    service,
    store,
    close,
    metrics,
    scheduler,
    recovery,
  };
}
if (require.main === module)
  (() => {
    const controller = new AbortController();
    for (const sig of ["SIGTERM", "SIGINT"])
      process.once(sig, () => controller.abort());
    return require("./recovery").supervise(startServer, {
      signal: controller.signal,
      onRetry: (code) => console.error("Server recovery retry:", code),
    });
  })().catch((e) => {
    console.error("Server startup failed:", e.code || e.message);
    if (e.code === "MIGRATION_REQUIRED") console.error(e.message);
    process.exit(1);
  });
module.exports = { startServer };
