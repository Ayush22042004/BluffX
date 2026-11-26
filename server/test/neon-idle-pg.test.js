process.env.GAME_DB_IDLE_MS = "1000";
process.env.DB_POOL_IDLE_MS = "1000";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { createGameStore } = require("../src/game-store");
const { startServer } = require("../src/index");
const { io } = require("./socket-client.cjs");
const URL = process.env.TEST_DATABASE_URL;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { for (let i = 0; i < 160; i++) { if (fn()) return; await sleep(50); } throw Error("Condition timed out"); }
function event(s, name, predicate = () => true) { return new Promise((ok, no) => {
  const timer = setTimeout(() => { s.off(name, receive); no(Error("Timeout " + name)); }, 20000);
  function receive(v) { if (predicate(v)) { clearTimeout(timer); s.off(name, receive); ok(v); } }
  s.on(name, receive);
}); }
function command(s, name, data = {}) { return new Promise((ok, no) => s.emit(name, data, value => value?.ok ? ok(value) : no(Error(JSON.stringify(value))))); }
test("real PostgreSQL: idle health makes no SQL; one cold wake restores online lobby seats, auth, fresh reconnect and legal gameplay", { skip: !URL, timeout: 120000 }, async () => {
  const store = await createGameStore({ connectionString: URL, directUrl: URL });
  const app = await startServer({ port: 0, store }), base = "http://127.0.0.1:" + app.server.address().port;
  const clients = []; let userId, roomId;
  let gameQueries = 0, recovery = false;
  app.recovery.then(() => { recovery = true; });
  const seen = new WeakSet();
  const instrument = client => { if (seen.has(client)) return; seen.add(client); const q = client.query.bind(client); client.query = (...args) => { gameQueries++; return q(...args); }; };
  store.pool._clients.forEach(instrument); store.pool.on("connect", instrument);
  async function connect(cookie, token) {
    const s = io(base, { autoConnect: false, transports: ["websocket"], extraHeaders: cookie ? { Cookie: cookie } : {}, auth: { resumeToken: token || "" } });
    clients.push(s); s.on("room_state", v => { s.latest = v; }); s.on("seat_session", v => { s.token = v.token; });
    const ready = event(s, "server_ready"); s.connect(); await ready; return s;
  }
  try {
    const signup = await fetch(base + "/auth/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Idle Recovery", email: `idle-${crypto.randomUUID()}@example.com`, password: "LongIdleTestPassword2026" }) });
    assert.equal(signup.status, 201); userId = (await signup.json()).user.id;
    const cookie = signup.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
    const host = await connect(cookie), guest = await connect();
    let received = event(host, "room_state"); await command(host, "create_room", { name: "Idle Recovery", maxPlayers: 2 }); roomId = (await received).roomId;
    received = event(guest, "room_state"); await command(guest, "join_room", { roomId, name: "Guest" }); await received;
    const originalSeat = guest.latest.you.id, originalDeadline = app.service.rooms.get(roomId).nextWakeAt;
    let replaced = 0; for (const s of [host, guest]) s.on("seat_replaced", () => { replaced++; });
    await until(() => store.parked && store.pool.totalCount === 0 && app.auth.database.poolState().total === 0);
    const initialEpoch = store.epoch, initialQueries = gameQueries, initialAuth = app.auth.database.queryCount;
    assert.equal(store.owner, null); assert.equal(store.available, true); assert.equal(recovery, false);
    for (let i = 0; i < 15; i++) {
      const r = await fetch(base + "/health"); assert.equal(r.status, 200); const state = await r.json(); assert.equal(state.storage, "idle"); assert.equal(state.ready, true);
    }
    assert.equal((await fetch(base + "/ready")).status, 200);
    assert.equal(gameQueries, initialQueries); assert.equal(app.auth.database.queryCount, initialAuth); assert.equal(store.parked, true);
    const versionBeforeRead = app.service.rooms.get(roomId).version;
    const generationsBeforeRead = app.service.rooms.get(roomId).players.map(p => p.controlGeneration);
    const continuous = await fetch(base + "/auth/stats", { headers: { cookie } });
    assert.equal(continuous.status, 200);
    assert.equal(app.service.rooms.get(roomId).version, versionBeforeRead, "a cold read must not persist an unchanged lobby");
    assert.deepEqual(app.service.rooms.get(roomId).players.map(p => p.controlGeneration), generationsBeforeRead);
    await until(() => store.parked);
    const authBeforeCompetition = app.auth.database.queryCount;
    const competing = await createGameStore({ connectionString: URL, directUrl: URL });
    let competingEpoch;
    try {
      competingEpoch = competing.epoch;
      const denied = await fetch(base + "/auth/stats", { headers: { cookie } });
      assert.equal(denied.status, 503);
      assert.match((await denied.json()).message, /temporarily unavailable/);
      assert.equal(store.parked, true);
      assert.equal(app.auth.database.queryCount, authBeforeCompetition);
    } finally { await competing.close(); }
    const [session, stats] = await Promise.all([
      fetch(base + "/auth/session", { headers: { cookie } }).then(r => r.json()),
      fetch(base + "/auth/stats", { headers: { cookie } }).then(r => r.json()),
      command(guest, "set_ready", { roomId, ready: true }),
    ]);
    assert.equal(session.user.id, userId); assert.equal(stats.stats.totalGames, 0); assert.equal(store.epoch, competingEpoch + 1);
    assert.ok(store.epoch > initialEpoch);
    assert.equal(replaced, 0); assert.equal(host.connected && guest.connected, true);
    assert.equal(app.service.rooms.get(roomId).nextWakeAt, originalDeadline);
    assert.ok(app.service.rooms.get(roomId).players.every(p => p.connected));
    assert.equal(app.service.rooms.get(roomId).players.find(p => p.id === originalSeat).ready, true);
    // A new transport recovers the persistent seat after ownership was parked.
    const resume = guest.token; guest.disconnect();
    const fresh = await connect(null, resume); await until(() => !!fresh.latest);
    assert.equal(fresh.latest.you.id, originalSeat);
    await command(fresh, "set_ready", { roomId, ready: true });
    const guestPlaying = event(fresh, "room_state", s => s.phase === "playing");
    received = event(host, "room_state", s => s.phase === "playing"); await command(host, "start_game", { roomId }); await Promise.all([received, guestPlaying]);
    assert.equal(host.latest.hand.length, 26); assert.equal(fresh.latest.hand.length, 26);
    await sleep(1300); assert.equal(store.parked, false, "active turn must retain authoritative ownership");
    received = event(fresh, "room_state", s => s.phase === "finished"); await command(host, "leave_room", { roomId }); await received;
    const records = await (await fetch(base + "/auth/stats", { headers: { cookie } })).json(); assert.equal(records.stats.totalGames, 1);
    assert.equal((await fetch(base + "/auth/history", { headers: { cookie } })).status, 200);
    assert.equal((await fetch(base + "/auth/leaderboard")).status, 200);
    await command(fresh, "leave_room", { roomId });
    await until(() => store.parked);
    assert.equal((await fetch(base + "/health")).status, 200);
    store.available = false;
    assert.equal((await fetch(base + "/health")).status, 200, "liveness must not restart Render for a database outage");
    assert.equal((await fetch(base + "/ready")).status, 503);
    store.available = true;
  } finally {
    for (const s of clients) s.disconnect();
    await app.close();
    const { Pool } = require("pg"); const { verifiedConnectionString } = require("../src/database");
    const cleanup = new Pool({ connectionString: verifiedConnectionString(URL), max: 1 });
    try {
      if (roomId) await cleanup.query("DELETE FROM bx_rooms WHERE room_code=$1", [roomId]);
      if (userId) await cleanup.query("DELETE FROM users WHERE id=$1", [userId]);
    } finally { await cleanup.end(); }
  }
});
