require("./postgres-fixture.cjs");
const test = require("node:test"),
  assert = require("node:assert/strict");
const { startServer } = require("../src/index");
const { MemoryGameStore } = require("./memory-game-store.cjs");
const { io } = require("./socket-client.cjs");
const event = (socket, name) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(Error("Timeout " + name)), 5000);
    socket.once(name, (data) => {
      clearTimeout(t);
      resolve(data);
    });
  });
const send = (socket, name, data = {}) =>
  new Promise((resolve, reject) =>
    socket
      .timeout(5000)
      .emit(name, data, (err, result) => (err ? reject(err) : resolve(result))),
  );

test("voice is seat-authorized, room-isolated, bounded, ephemeral and cleaned up on leave/disconnect", async () => {
  const store = new MemoryGameStore(),
    server = await startServer({ port: 0, store });
  const sockets = [];
  try {
    async function connect() {
      const s = io("http://localhost:" + server.server.address().port, {
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
      b = await connect(),
      outsider = await connect();
    assert.equal((await send(outsider, "voice_join")).ok, false);
    const room = await send(a, "create_room", { name: "A", maxPlayers: 2 });
    await send(b, "join_room", { roomId: room.roomId, name: "B" });
    await send(outsider, "create_room", { name: "Other table", maxPlayers: 2 });
    await send(outsider, "voice_join");
    const initialWrites = store.commitCount;
    assert.equal((await send(a, "voice_join")).peers.length, 1);
    const joined = await send(b, "voice_join");
    assert.equal(joined.peers.length, 2);
    const signalIdentity = {
      voiceId: joined.peers.find((p) => p.socketId === a.id).voiceId,
      targetVoiceId: joined.peers.find((p) => p.socketId === b.id).voiceId,
    };
    assert.equal(
      joined.peers.every((p) => p.muted),
      true,
    );
    assert.equal(JSON.stringify(joined).includes("resume"), false);
    assert.equal((await send(a, "voice_mute", { muted: false })).ok, true);
    let got = event(b, "voice_signal");
    assert.equal(
      (
        await send(a, "voice_signal", {
          ...signalIdentity,
          to: b.id,
          signal: { description: { type: "offer", sdp: "v=0" } },
        })
      ).ok,
      true,
    );
    assert.equal((await got).from, a.id);
    assert.equal(
      (
        await send(a, "voice_signal", {
          ...signalIdentity,
          to: outsider.id,
          signal: { candidate: { candidate: "candidate:123" } },
        })
      ).ok,
      false,
    );
    assert.equal(
      (
        await send(a, "voice_signal", {
          ...signalIdentity,
          to: b.id,
          signal: { description: { type: "evil", sdp: "v=0" } },
        })
      ).ok,
      false,
    );
    assert.equal((await send(a, "voice_mute", { muted: "false" })).ok, false);
    await send(b, "voice_leave");
    const rejoined = await send(b, "voice_join");
    assert.notEqual(
      rejoined.peers.find((p) => p.socketId === b.id).voiceId,
      signalIdentity.targetVoiceId,
    );
    assert.equal(
      (
        await send(a, "voice_signal", {
          ...signalIdentity,
          to: b.id,
          signal: { description: { type: "offer", sdp: "v=0" } },
        })
      ).ok,
      false,
      "stale voice sessions cannot signal a rejoined peer",
    );
    assert.equal(
      store.commitCount,
      initialWrites,
      "signaling must not write game state",
    );
    const roster = event(b, "voice_roster");
    a.disconnect();
    assert.equal((await roster).peers.length, 1);
    const closed = event(b, "voice_closed");
    await send(b, "leave_room");
    await closed;
    assert.equal((await send(b, "voice_join")).ok, false);
    const beforeFlood = store.commitCount;
    const results = await Promise.all(
      Array.from({ length: 110 }, () =>
        send(outsider, "voice_mute", { muted: true }),
      ),
    );
    assert.ok(results.some((r) => r.code === "RATE_LIMITED"));
    assert.equal(store.commitCount, beforeFlood);
  } finally {
    sockets.forEach((s) => s.disconnect());
    await server.close();
  }
});
