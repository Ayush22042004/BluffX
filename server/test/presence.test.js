const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createDeck,
  startGame,
  applyPlay,
  applyPass,
  nextRound,
  publicState,
} = require("../src/game");
const {
  markOffline,
  markOnline,
  tickPresence,
  removePlayer,
} = require("../src/presence");
function room(count = 4) {
  const r = {
    id: "room",
    players: Array.from({ length: count }, (_, i) => ({
      id: String(i),
      name: `Player ${i}`,
      isBot: false,
      ready: true,
      connected: true,
    })),
    hostId: "0",
    turnSeconds: 30,
  };
  startGame(r, createDeck());
  return r;
}
function allCards(r) {
  return [...Object.values(r.hands).flat(), ...r.pile, ...r.discard];
}
function closeOneRound(r) {
  const actor = r.players[r.currentTurnIndex];
  applyPlay(r, actor.id, [r.hands[actor.id][0].id], r.hands[actor.id][0].rank);
  while (r.phase === "playing") applyPass(r, r.players[r.currentTurnIndex].id);
}
test("offline grace freezes the exact turn budget, rejects moves, and reconnect restores the original hand", () => {
  const r = room(),
    original = r.hands["0"].map((c) => c.id);
  r.turnEndsAt = 25000;
  markOffline(r, "0", 10000);
  assert.equal(r.turnEndsAt, null);
  assert.equal(r.pause.remainingMs, 15000);
  assert.equal(r.pause.until, 20000);
  assert.equal(r.hostId, "1");
  assert.throws(() => applyPlay(r, "0", [original[0]], "J"), /paused/);
  assert.equal(markOffline(r, "0", 11000), false);
  markOnline(r, "0", 14000);
  assert.equal(r.pause, null);
  assert.equal(r.turnEndsAt, 29000);
  assert.deepEqual(
    r.hands["0"].map((c) => c.id),
    original,
  );
  assert.equal(r.players[0].aiTakeover, false);
});
test("simultaneous disconnects each get ten seconds without losing the frozen turn budget", () => {
  const r = room();
  r.turnEndsAt = 30000;
  markOffline(r, "0", 1000);
  markOffline(r, "1", 3000);
  tickPresence(r, 11000);
  assert.equal(r.players[0].aiTakeover, true);
  assert.equal(r.pause.until, 13000);
  assert.equal(r.turnEndsAt, null);
  markOnline(r, "1", 12000);
  assert.equal(r.pause, null);
  assert.equal(r.turnEndsAt, 41000);
});
test("AI takeover lasts three completed game rounds and shrinks a four-player table to three", () => {
  const r = room();
  markOffline(r, "3", 1000);
  tickPresence(r, 10999);
  assert.equal(r.players[3].aiTakeover, false);
  tickPresence(r, 11000);
  assert.equal(r.pause, null);
  assert.equal(r.players[3].aiTakeover, true);
  assert.equal(publicState(r, "0").players[3].aiRoundsRemaining, 3);
  for (let n = 1; n <= 3; n++) {
    closeOneRound(r);
    const result = tickPresence(r, 12000 + n);
    if (n < 3) {
      assert.equal(result.removed.length, 0);
      assert.equal(publicState(r, "0").players[3].aiRoundsRemaining, 3 - n);
      nextRound(r);
    } else assert.equal(result.removed[0].id, "3");
  }
  assert.equal(r.players.length, 3);
  assert.equal(r.phase, "round_result");
  assert.equal(allCards(r).length, 52);
  assert.equal(new Set(allCards(r).map((c) => c.id)).size, 52);
  assert.match(r.presenceEvents.at(-1).message, /removed/);
});
test("the remaining online player wins a two-player game after three AI rounds", () => {
  const r = room(2);
  markOffline(r, "1", 1000);
  tickPresence(r, 11000);
  for (let n = 1; n <= 3; n++) {
    closeOneRound(r);
    tickPresence(r, 12000 + n);
    if (n < 3) nextRound(r);
  }
  assert.equal(r.players.length, 1);
  assert.equal(r.phase, "finished");
  assert.equal(r.winnerId, "0");
  assert.equal(r.winReason, "last_player");
  assert.equal(r.turnEndsAt, null);
  assert.equal(allCards(r).length, 52);
});
test("returning during AI takeover stops the proxy without replacing seat or cards", () => {
  const r = room();
  markOffline(r, "2", 1000);
  tickPresence(r, 11000);
  closeOneRound(r);
  tickPresence(r, 12000);
  nextRound(r);
  const hand = r.hands["2"].map((c) => c.id);
  markOnline(r, "2", 13000);
  assert.equal(r.players[2].id, "2");
  assert.equal(r.players[2].aiTakeover, false);
  assert.deepEqual(
    r.hands["2"].map((c) => c.id),
    hand,
  );
  r.completedRounds += 3;
  assert.equal(tickPresence(r, 14000).removed.length, 0);
});
test("lobby seats expire without AI, and removing a current player keeps the next seat and deck valid", () => {
  const r = room();
  r.currentTurnIndex = 1;
  removePlayer(r, "1", "left", 1000);
  assert.equal(r.players[r.currentTurnIndex].id, "2");
  assert.equal(allCards(r).length, 52);
  r.phase = "lobby";
  markOffline(r, "0", 2000);
  tickPresence(r, 12000);
  assert.ok(!r.players.some((p) => p.id === "0"));
  assert.equal(r.players.length, 2);
});
test("resume credentials, account identifiers and transport details are never in public state", () => {
  const r = room();
  Object.assign(r.players[0], {
    resumeHash: "secret",
    accountId: "private",
    socketId: "transport",
  });
  const state = publicState(r, "0");
  assert.equal(state.you.resumeHash, undefined);
  assert.equal(state.players[0].accountId, undefined);
  assert.equal(state.players[0].socketId, undefined);
});
