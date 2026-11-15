const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const path = require("node:path");
const { io } = require("./socket-client.cjs");
const { envelope } = require("../src/protocol");
const event = (s, name, predicate = () => true) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      s.off(name, fn);
      reject(Error("Timeout " + name));
    }, 10000);
    function fn(v) {
      if (predicate(v)) {
        clearTimeout(timer);
        s.off(name, fn);
        resolve(v);
      }
    }
    s.on(name, fn);
  });
test("socket flood protection and cached duplicates do not flood other players or admit fake results", async () => {
  const server = spawn(
    process.execPath,
    ["--require", "./test/postgres-fixture.cjs", "src/index.js"],
    {
      cwd: path.resolve(__dirname, ".."),
      env: { ...process.env, PORT: "4014" },
      stdio: "pipe",
    },
  );
  let a, b;
  const request = (s, name, data) =>
    new Promise((resolve) => s.emit(name, data, resolve));
  try {
    for (let i = 0; i < 80; i++) {
      try {
        if ((await fetch("http://localhost:4014/health")).ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    a = io("http://localhost:4014", {
      autoConnect: false,
      transports: ["websocket"],
    });
    let waiting = event(a, "connect");
    a.connect();
    await waiting;
    waiting = event(a, "room_state");
    a.emit("create_room", { name: "Host", maxPlayers: 2 });
    const lobby = await waiting,
      code = lobby.roomId;
    b = io("http://localhost:4014", {
      autoConnect: false,
      transports: ["websocket"],
    });
    waiting = event(b, "connect");
    b.connect();
    await waiting;
    waiting = event(b, "room_state");
    b.emit("join_room", { roomId: code, name: "Observer" });
    const state = await waiting;
    let broadcasts = 0;
    b.on("room_state", () => broadcasts++);
    const fake = await request(a, "submit_victory", {
      actionId: crypto.randomUUID(),
      winnerId: lobby.you.id,
    });
    assert.equal(fake.code, "UNKNOWN_ACTION");
    const spoof = await request(a, "set_ready", {
      roomId: code,
      ready: true,
      playerId: state.you.id,
    });
    assert.equal(spoof.code, "INVALID_PAYLOAD");
    const data = {
      ...envelope(state),
      roomId: code,
      ready: true,
      actionId: crypto.randomUUID(),
    };
    const changed = event(b, "room_state", (s) => s.version > state.version);
    const first = await request(a, "set_ready", data);
    assert.equal(first.ok, true);
    await changed;
    const count = broadcasts;
    const repeated = await Promise.all(
      Array.from({ length: 100 }, () => request(a, "set_ready", data)),
    );
    assert.ok(repeated.every((r) => r.ok && r.duplicate));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(broadcasts, count);
    const flooded = await Promise.all(
      Array.from({ length: 100 }, () =>
        request(a, "play_cards", {
          roomId: code,
          cardIds: ["not-owned"],
          declaredRank: "J",
        }),
      ),
    );
    assert.ok(flooded.some((r) => r.code === "RATE_LIMITED"));
    assert.ok(flooded.every((r) => !r.ok));
    assert.equal(broadcasts, count);
    const tampered = await fetch("http://localhost:4014/auth/leaderboard", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wins: 999999 }),
    });
    assert.equal(tampered.status, 404);
    const ranks = await (
      await fetch("http://localhost:4014/auth/leaderboard")
    ).json();
    assert.equal(ranks.total, 0);
  } finally {
    a?.disconnect();
    b?.disconnect();
    server.kill();
  }
});
