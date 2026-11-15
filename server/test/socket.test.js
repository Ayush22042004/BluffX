const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");
const { io } = require("./socket-client.cjs");
function event(s, name, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      s.off(name, fn);
      reject(Error(`Timeout: ${name}`));
    }, 6000);
    function fn(data) {
      if (predicate(data)) {
        clearTimeout(t);
        s.off(name, fn);
        resolve(data);
      }
    }
    s.on(name, fn);
  });
}
test("socket lifecycle: AI counts, validation, profile, password, ready, win, rematch and leave", async () => {
  const server = spawn(
    process.execPath,
    ["--require", "./test/postgres-fixture.cjs", "src/index.js"],
    {
      cwd: path.resolve(__dirname, ".."),
      env: { ...process.env, PORT: "4011" },
      stdio: "pipe",
    },
  );
  let a, b;
  try {
    for (let i = 0; i < 40; i++) {
      try {
        if ((await fetch("http://localhost:4011/health")).ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    a = io("http://localhost:4011", { transports: ["websocket"] });
    await event(a, "connect");
    let next = event(a, "action_error");
    a.emit("create_ai_room", { name: "Tester", botCount: 0 });
    assert.match((await next).message, /1 and 5/);
    for (const n of [1, 5]) {
      next = event(a, "room_state");
      a.emit("create_ai_room", { name: "Tester", avatar: 2, botCount: n });
      let s = await next;
      assert.equal(s.players.length, n + 1);
      assert.equal(s.you.avatar, 2);
      next = event(a, "room_state", (s) => s.phase === "playing");
      a.emit("start_game", { roomId: s.roomId });
      s = await next;
      assert.equal(
        Object.values(s.playerHandsCount).reduce((a, b) => a + b),
        52,
      );
      next = event(a, "room_left");
      a.emit("leave_room");
      await next;
    }
    next = event(a, "room_state");
    a.emit("create_room", {
      name: "Host",
      avatar: 0,
      maxPlayers: 2,
      password: "secret",
      roomName: "Test Table",
    });
    let state = await next;
    const code = state.roomId;
    b = io("http://localhost:4011", { transports: ["websocket"] });
    await event(b, "connect");
    next = event(b, "action_error");
    b.emit("join_room", { roomId: code, name: "Guest" });
    assert.match((await next).message, /password/);
    next = event(b, "room_state");
    b.emit("join_room", { roomId: code, name: "Guest", password: "secret" });
    await next;
    next = event(a, "action_error");
    a.emit("start_game", { roomId: code });
    assert.match((await next).message, /ready/);
    next = event(a, "room_state", (s) => s.players.every((p) => p.ready));
    b.emit("set_ready", { roomId: code, ready: true });
    await next;
    next = event(a, "room_state", (s) => s.you.name === "Renamed");
    a.emit("update_profile", { name: "Renamed", avatar: 4 });
    assert.equal((await next).you.avatar, 4);
    next = event(a, "room_state", (s) => s.phase === "playing");
    a.emit("start_game", { roomId: code });
    state = await next;
    const matchId = state.matchId;
    const hostSeat = state.you.id;
    while (state.hand.length) {
      const last = state.hand.length <= 4;
      next = event(b, "room_state", (s) => s.lastMove?.playerId === hostSeat);
      a.emit("play_cards", {
        roomId: code,
        cardIds: state.hand.slice(0, 4).map((c) => c.id),
        declaredRank: "J",
      });
      const peerState = await next;
      assert.equal(peerState.lastMove.cards, undefined);
      if (last) {
        next = event(b, "action_error");
        b.emit("play_cards", {
          roomId: code,
          cardIds: [peerState.hand[0].id],
          declaredRank: "J",
        });
        assert.match((await next).message, /Final claim/);
      }
      next = event(
        a,
        "room_state",
        (s) => s.phase === (last ? "finished" : "round_result"),
      );
      b.emit("pass_bluff", { roomId: code });
      state = await next;
      if (!last) {
        next = event(a, "room_state", (s) => s.phase === "playing");
        a.emit("continue_round", { roomId: code });
        state = await next;
      }
    }
    assert.equal(state.winnerId, hostSeat);
    assert.equal(state.hand.length, 0);
    assert.equal(state.turnEndsAt, null);
    next = event(a, "room_state", (s) => s.phase === "lobby");
    a.emit("restart_game", { roomId: code });
    state = await next;
    assert.equal(state.you.ready, true);
    assert.equal(state.players.find((p) => p.id !== state.you.id).ready, false);
    next = event(a, "room_state", (s) => s.players.every((p) => p.ready));
    const firstReady = event(a, "room_state", (s) => s.you.ready);
    a.emit("set_ready", { roomId: code, ready: true });
    await firstReady;
    b.emit("set_ready", { roomId: code, ready: true });
    await next;
    next = event(a, "room_state", (s) => s.phase === "playing");
    a.emit("start_game", { roomId: code });
    state = await next;
    assert.notEqual(state.matchId, matchId);
    assert.equal(state.hand.length, 26);
    const chat = event(a, "chat_message");
    b.emit("send_chat", { roomId: code, text: "Hello table" });
    assert.equal((await chat).text, "Hello table");
    next = event(a, "room_left");
    a.emit("leave_room");
    await next;
  } finally {
    a?.disconnect();
    b?.disconnect();
    server.kill();
  }
});
