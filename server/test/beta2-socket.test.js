require("./postgres-fixture.cjs");
const test = require("node:test"),
  assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { startServer } = require("../src/index");
const { MemoryGameStore } = require("./memory-game-store.cjs");
const { io } = require("./socket-client.cjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const event = (s, name) =>
  new Promise((ok, no) => {
    const timer = setTimeout(() => no(Error("Timeout " + name)), 5000);
    s.once(name, (v) => {
      clearTimeout(timer);
      ok(v);
    });
  });
const send = (s, event, data = {}) =>
  new Promise((ok, no) =>
    s
      .timeout(5000)
      .emit(event, data, (err, r) =>
        err ? no(err) : r.ok ? ok(r) : no(Error(r.code)),
      ),
  );
test("idle rooms perform no queries, writes or broadcasts; patch gaps resync privately and sockets/listeners clean up", async () => {
  process.env.GAME_DIAGNOSTICS = "true";
  const store = new MemoryGameStore();
  let reads = 0;
  const receipt = store.receipt.bind(store);
  store.receipt = (...args) => {
    reads++;
    return receipt(...args);
  };
  const server = await startServer({ port: 0, store });
  const url = "http://localhost:" + server.server.address().port,
    sockets = [];
  try {
    async function connect() {
      const s = io(url, {
        autoConnect: false,
        transports: ["websocket"],
        reconnection: false,
      });
      sockets.push(s);
      const wait = event(s, "server_ready");
      s.connect();
      await wait;
      return s;
    }
    const a = await connect(),
      b = await connect();
    let lastA, lastB;
    a.on("room_state", (s) => (lastA = s));
    b.on("room_state", (s) => (lastB = s));
    const created = await send(a, "create_room", {
      name: "A",
      maxPlayers: 2,
      turnSeconds: 20,
    });
    await send(b, "join_room", { roomId: created.roomId, name: "B" });
    await send(b, "set_ready", { ready: true });
    await send(a, "start_game");
    await sleep(30);
    const before = {
      reads,
      writes: store.commitCount,
      messages: server.metrics.counts.messages || 0,
      wakeups: server.scheduler.wakeups,
    };
    await sleep(1100);
    assert.equal(store.commitCount, before.writes);
    assert.equal(reads, before.reads);
    assert.equal(server.metrics.counts.messages, before.messages);
    assert.equal(server.scheduler.wakeups, before.wakeups);
    assert.equal(server.scheduler.heap.length, 1);
    assert.ok(server.scheduler.timer);
    const connected = server.io.sockets.sockets.get(a.id),
      snapshots = [];
    a.on("room_state", (s) => snapshots.push(s));
    delete connected.data.stateVersion;
    await send(b, "update_profile", { name: "Updated", avatar: 1 });
    await sleep(20);
    assert.equal(lastA.players[1].name, "Updated");
    assert.equal(lastA.hands, undefined);
    const result = await send(a, "sync_room", {
      roomId: created.roomId,
      actionId: crypto.randomUUID(),
    });
    assert.equal(result.version, lastA.version);
    assert.equal(lastA.hand.length, 26);
    assert.ok(!JSON.stringify(lastA).includes(lastB.hand[0].id));
    const metrics = await (await fetch(url + "/debug/metrics")).json();
    assert.equal(metrics.activeRooms, 1);
    assert.equal(metrics.connectedSockets, 2);
    assert.ok(metrics.latency.actionMs.count > 0);
    assert.ok(metrics.latency.persistenceMs.count > 0);
    assert.ok(!JSON.stringify(metrics).includes(created.roomId));
    const oldSocket = server.io.sockets.sockets.get(b.id);
    b.disconnect();
    await sleep(30);
    assert.equal(server.io.sockets.sockets.has(b.id), false);
    assert.equal(oldSocket.eventNames().length, 0);
    assert.equal(oldSocket.listenersAny().length, 0);
    assert.equal(oldSocket.listenersAnyOutgoing().length, 0);
  } finally {
    for (const s of sockets) s.disconnect();
    await server.close();
    delete process.env.GAME_DIAGNOSTICS;
    assert.equal(server.scheduler.heap.length, 0);
    assert.equal(server.scheduler.timer, null);
  }
});
