// Local capacity benchmark. Never selects the app's production database.
const { performance, monitorEventLoopDelay } = require("node:perf_hooks");
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1];
};
const postgres = args.includes("--postgres");
if (postgres) require("../test/real-db-env.cjs");
else require("../test/postgres-fixture.cjs");
// All test clients share loopback. Flood protection is verified separately.
require("../src/protocol").RateLimiter.prototype.consume = function () {};
const { startServer } = require("../src/index");
const { MemoryGameStore } = require("../test/memory-game-store.cjs");
const { io } = require("../test/socket-client.cjs");
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const percentile = (a, p) =>
  a.length
    ? [...a].sort((x, y) => x - y)[
        Math.min(a.length - 1, Math.floor(a.length * p))
      ]
    : 0;
const summary = (a) => ({
  count: a.length,
  averageMs: a.reduce((x, y) => x + y, 0) / (a.length || 1),
  p95Ms: percentile(a, 0.95),
});
async function main() {
  const roomCount = Number(option("--rooms", postgres ? 3 : 20)),
    rounds = Number(option("--rounds", postgres ? 2 : 8));
  if (
    !Number.isInteger(roomCount) ||
    roomCount < 2 ||
    roomCount > 100 ||
    rounds < 1 ||
    rounds > 10
  )
    throw Error("Use 2..100 rooms and 1..10 rounds.");
  let store = postgres
    ? await require("../src/game-store").createGameStore({ autoMigrate: false })
    : new MemoryGameStore();
  let sql = 0,
    lookups = 0,
    commits = 0;
  const persistence = [],
    actions = [];
  if (postgres) {
    const wrapped = new WeakSet();
    const wrap = (c) => {
      if (wrapped.has(c)) return;
      wrapped.add(c);
      const q = c.query.bind(c);
      c.query = (...a) => {
        sql++;
        return q(...a);
      };
    };
    store.pool._clients.forEach(wrap);
    store.pool.on("connect", wrap);
  }
  const commit = store.commit.bind(store);
  store.commit = async (...a) => {
    const t = performance.now();
    try {
      return await commit(...a);
    } finally {
      commits++;
      persistence.push(performance.now() - t);
    }
  };
  for (const key of ["receipt", "receiptAnywhere"]) {
    const read = store[key].bind(store);
    store[key] = (...a) => {
      lookups++;
      return read(...a);
    };
  }
  const app = await startServer({ port: 0, store });
  let clock = Date.now();
  app.service.now = () => clock;
  let messages = 0,
    bytes = 0,
    completed = 0,
    takeovers = 0;
  const seen = new Map();
  const callback = app.service.onCommit;
  app.service.onCommit = (r, e) => {
    const before = seen.get(r.id) || { rounds: 0, ai: 0 };
    completed += Math.max(0, (r.completedRounds || 0) - before.rounds);
    const ai =
      r.presenceEvents?.filter((x) => x.type === "ai_takeover").length || 0;
    takeovers += Math.max(0, ai - before.ai);
    seen.set(r.id, { rounds: r.completedRounds || 0, ai });
    callback(r, e);
  };
  app.io.on("connection", (s) =>
    s.onAnyOutgoing((event, ...data) => {
      messages++;
      bytes += Buffer.byteLength(JSON.stringify([event, ...data]));
    }),
  );
  const sockets = [],
    groups = [],
    latest = new Map();
  let peakRss = process.memoryUsage().rss;
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 100);
  sampler.unref();
  const lag = monitorEventLoopDelay({ resolution: 20 });
  lag.enable();
  const cpu = process.cpuUsage(),
    started = performance.now();
  async function connect() {
    const s = io(`http://localhost:${app.server.address().port}`, {
      autoConnect: false,
      transports: ["websocket"],
      reconnection: false,
    });
    sockets.push(s);
    s.on("room_state", (v) => latest.set(s, v));
    await new Promise((ok, fail) => {
      s.once("server_ready", ok);
      s.once("connect_error", fail);
      s.connect();
    });
    return s;
  }
  async function send(s, event, data = {}) {
    const t = performance.now();
    const ack = await new Promise((resolve, reject) =>
      s
        .timeout(30000)
        .emit(event, data, (err, result) =>
          err ? reject(err) : resolve(result),
        ),
    );
    if (!ack?.ok) throw Error(event + ": " + ack?.code);
    actions.push(performance.now() - t);
    const until = performance.now() + 5000;
    while (
      sockets.some(
        (peer) =>
          peer.connected &&
          latest.get(peer)?.roomId === ack.roomId &&
          latest.get(peer).version < ack.version,
      )
    ) {
      if (performance.now() > until)
        throw Error("State synchronization timed out");
      await pause(1);
    }
    return ack;
  }
  try {
    for (let i = 0; i < roomCount; i++) {
      const a = await connect(),
        b = await connect();
      const c = await send(a, "create_room", {
        name: "Load A",
        maxPlayers: 2,
        turnSeconds: 60,
      });
      await send(b, "join_room", { roomId: c.roomId, name: "Load B" });
      await send(b, "set_ready", { ready: true });
      await send(a, "start_game");
      groups.push([a, b]);
    }
    const before = { sql, lookups, commits, messages, bytes };
    const workStarted = performance.now();
    const beforeCpu = process.cpuUsage();
    const beforeActions = actions.length;
    for (let n = 0; n < rounds; n++)
      await Promise.all(
        groups.map(async (pair) => {
          const state = latest.get(pair[0]);
          const current = pair.find(
            (s) => latest.get(s).you.id === state.currentTurnId,
          );
          const opponent = pair.find((s) => s !== current);
          await send(current, "play_cards", {
            cardIds: [latest.get(current).hand[0].id],
            declaredRank: "J",
          });
          await send(opponent, "call_bluff", { selectedIndexes: [0] });
          await send(pair[0], "continue_round");
        }),
      );
    await pause(30);
    const workMs = performance.now() - workStarted,
      workCpu = process.cpuUsage(beforeCpu);
    const workload = {
      ...summary(actions.slice(beforeActions)),
      rounds: completed,
      wallMs: workMs,
      cpuMs: (workCpu.user + workCpu.system) / 1000,
      sqlQueries: postgres ? sql - before.sql : null,
      receiptLookups: lookups - before.lookups,
      commits: commits - before.commits,
      messages: messages - before.messages,
      bytes: bytes - before.bytes,
    };
    const idleBefore = { sql, lookups, commits, messages };
    await pause(2000);
    const idle = {
      durationMs: 2000,
      sqlQueries: postgres ? sql - idleBefore.sql : null,
      receiptLookups: lookups - idleBefore.lookups,
      commits: commits - idleBefore.commits,
      messages: messages - idleBefore.messages,
    };
    groups[0][1].disconnect();
    await pause(30);
    clock += 10001;
    await app.service.tick();
    clock += 240000;
    await app.service.tick();
    await pause(30);
    const used = process.cpuUsage(cpu);
    const result = {
      release: require("../package.json").version,
      mode: postgres ? "isolated-neon" : "in-memory-test-double",
      roomCount,
      roundsPerRoom: rounds,
      rateLimitsDisabledForLoopback: true,
      workload,
      idle,
      persistence: summary(persistence),
      elapsedMs: performance.now() - started,
      cpuMs: (used.user + used.system) / 1000,
      rssBytes: process.memoryUsage().rss,
      peakRssBytes: peakRss,
      heapUsedBytes: process.memoryUsage().heapUsed,
      eventLoopP95Ms: lag.percentile(95) / 1e6,
      appMessages: messages,
      appBytes: bytes,
      aiTakeovers: takeovers,
      activeRooms: app.service.rooms.size,
      sockets: app.io.sockets.sockets.size,
    };
    const output = option("--output", null);
    if (output) {
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
    }
    console.log(JSON.stringify(result, null, 2));
  } finally {
    clearInterval(sampler);
    lag.disable();
    for (const s of sockets) s.disconnect();
    await pause(30);
    await app.close();
  }
}
main().catch((e) => {
  console.error("Load check failed:", e.code || e.message);
  process.exitCode = 1;
});
