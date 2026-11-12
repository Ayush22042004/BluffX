const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");
const { io } = require("../../client/node_modules/socket.io-client");
const event = (s, name, check = () => true, ms = 16000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      s.off(name, fn);
      reject(Error(`Timeout ${name}`));
    }, ms);
    function fn(value) {
      if (check(value)) {
        clearTimeout(timer);
        s.off(name, fn);
        resolve(value);
      }
    }
    s.on(name, fn);
  });
test("real sockets preserve a disconnected seat, rotate private resume tokens, and start AI only after grace", async () => {
  const server = spawn(
    process.execPath,
    ["--require", "./test/postgres-fixture.cjs", "src/index.js"],
    {
      cwd: path.resolve(__dirname, ".."),
      env: { ...process.env, PORT: "4013" },
      stdio: "pipe",
    },
  );
  const sockets = [];
  async function connect(token) {
    const socket = io("http://localhost:4013", {
      autoConnect: false,
      transports: ["websocket"],
      auth: { resumeToken: token || "" },
    });
    sockets.push(socket);
    const connected = event(socket, "connect");
    socket.connect();
    await connected;
    return socket;
  }
  try {
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch("http://localhost:4013/health")).ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    const a = await connect(),
      b = await connect();
    let stateEvent = event(a, "room_state"),
      tokenEvent = event(a, "seat_session");
    a.emit("create_room", { name: "Host", maxPlayers: 2 });
    const lobby = await stateEvent,
      firstToken = (await tokenEvent).token,
      seatId = lobby.you.id,
      roomId = lobby.roomId;
    stateEvent = event(b, "room_state");
    b.emit("join_room", { roomId, name: "Peer" });
    await stateEvent;
    stateEvent = event(a, "room_state", (s) => s.players.every((p) => p.ready));
    b.emit("set_ready", { roomId, ready: true });
    await stateEvent;
    stateEvent = event(a, "room_state", (s) => s.phase === "playing");
    a.emit("start_game", { roomId });
    const dealt = await stateEvent;
    const hand = dealt.hand.map((c) => c.id);
    stateEvent = event(b, "room_state", (s) => !!s.pause);
    a.disconnect();
    const paused = await stateEvent;
    assert.equal(paused.players.length, 2);
    assert.equal(paused.players.find((p) => p.id === seatId).connected, false);
    assert.equal(paused.turnEndsAt, null);
    const error = event(b, "action_error");
    b.emit("play_cards", {
      roomId,
      cardIds: [paused.hand[0].id],
      declaredRank: "J",
    });
    assert.match((await error).message, /paused/);
    const resumed = io("http://localhost:4013", {
      autoConnect: false,
      transports: ["websocket"],
      auth: { resumeToken: firstToken },
    });
    sockets.push(resumed);
    stateEvent = event(resumed, "room_state");
    tokenEvent = event(resumed, "seat_session");
    resumed.connect();
    const restored = await stateEvent;
    assert.equal(restored.you.id, seatId);
    assert.notEqual(resumed.id, seatId);
    assert.deepEqual(
      restored.hand.map((c) => c.id),
      hand,
    );
    assert.equal(restored.pause, null);
    assert.notEqual((await tokenEvent).token, firstToken);
    assert.equal(restored.players[0].resumeHash, undefined);
    stateEvent = event(b, "room_state", (s) => !!s.pause);
    resumed.disconnect();
    await stateEvent;
    stateEvent = event(b, "room_state", (s) =>
      s.players.some((p) => p.id === seatId && p.aiTakeover),
    );
    const takeover = await stateEvent;
    assert.equal(
      takeover.players.find((p) => p.id === seatId).aiRoundsRemaining,
      3,
    );
    assert.equal(takeover.pause, null);
    assert.ok(takeover.presenceEvents.some((e) => e.type === "ai_takeover"));
    assert.equal(takeover.hostId, b.id);
  } finally {
    sockets.forEach((s) => s.disconnect());
    server.kill();
  }
});
