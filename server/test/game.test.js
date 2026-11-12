const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createDeck,
  startGame,
  applyPlay,
  applyPass,
  applyChallenge,
  nextRound,
  publicState,
} = require("../src/game");
function room(n = 4) {
  return {
    id: "TEST",
    hostId: "p0",
    players: Array.from({ length: n }, (_, i) => ({
      id: `p${i}`,
      name: `Player ${i}`,
    })),
    turnSeconds: 30,
    roundNumber: 1,
    pile: [],
    discard: [],
    hands: {},
    phase: "lobby",
    currentTurnIndex: 0,
  };
}
function fixture(ranks) {
  const r = room(ranks.length);
  r.hands = Object.fromEntries(
    ranks.map((rs, i) => [
      `p${i}`,
      rs.map((rank, j) => ({ id: `${i}-${j}`, rank, suit: "H" })),
    ]),
  );
  r.phase = "playing";
  return r;
}
function total(r) {
  return Object.values(r.hands).flat().concat(r.pile, r.discard);
}
test("deals exactly 52 unique cards for 2 through 6 players", () => {
  for (let n = 2; n <= 6; n++) {
    const r = room(n);
    startGame(r, createDeck());
    const cards = total(r);
    assert.equal(cards.length, 52);
    assert.equal(new Set(cards.map((c) => c.id)).size, 52);
    assert.ok(
      Math.max(...Object.values(r.hands).map((h) => h.length)) -
        Math.min(...Object.values(r.hands).map((h) => h.length)) <=
        1,
    );
  }
});
test("final claim waits for every opponent, then wins", () => {
  const r = fixture([["J"], ["2"], ["3"], ["4"]]);
  applyPlay(r, "p0", ["0-0"], "J");
  assert.equal(r.pendingWinnerId, "p0");
  for (const id of ["p1", "p2"]) {
    applyPass(r, id);
    assert.equal(r.phase, "playing");
  }
  applyPass(r, "p3");
  assert.equal(r.phase, "finished");
  assert.equal(r.winnerId, "p0");
  assert.equal(r.turnEndsAt, null);
});
test("regression: truthful final claim challenged must end the game", () => {
  const r = fixture([["J"], ["2"]]);
  applyPlay(r, "p0", ["0-0"], "J");
  applyChallenge(r, "p1", [0]);
  assert.equal(r.phase, "finished");
  assert.equal(r.winnerId, "p0");
  assert.equal(r.hands.p0.length, 0);
  assert.equal(r.hands.p1.length, 2);
  assert.equal(r.turnEndsAt, null);
});
test("caught final bluff takes the pile and resumes with cards after result", () => {
  const r = fixture([["2"], ["J"]]);
  applyPlay(r, "p0", ["0-0"], "J");
  const result = applyChallenge(r, "p1", [0]);
  assert.equal(result.foundFake, true);
  assert.equal(r.phase, "round_result");
  assert.equal(r.hands.p0.length, 1);
  assert.equal(r.pendingWinnerId, null);
  assert.equal(r.winnerId, undefined);
  assert.equal(r.turnEndsAt, null);
  nextRound(r);
  assert.equal(r.phase, "playing");
  assert.equal(r.roundNumber, 2);
  assert.equal(r.players[r.currentTurnIndex].id, "p1");
});
test("cannot play over a pending winning claim, including bots", () => {
  const r = fixture([["J"], ["2", "3"]]);
  applyPlay(r, "p0", ["0-0"], "J");
  assert.throws(() => applyPlay(r, "p1", ["1-0"], "J"), /Final claim/);
  assert.equal(r.lastMove.playerId, "p0");
  assert.equal(r.pendingWinnerId, "p0");
});
test("public room state never exposes played cards or other hands", () => {
  const r = fixture([
    ["J", "2"],
    ["3", "4"],
  ]);
  applyPlay(r, "p0", ["0-0"], "J");
  const s = publicState(r, "p1");
  assert.equal(s.lastMove.cards, undefined);
  assert.equal(s.hands, undefined);
  assert.deepEqual(s.hand, r.hands.p1);
  assert.equal(s.lastMove.cardCount, 1);
});
test("all-pass round preserves discarded cards, pauses, and lets claimant restart", () => {
  const r = fixture([
    ["J", "2"],
    ["3", "4"],
  ]);
  applyPlay(r, "p0", ["0-0"], "J");
  applyPass(r, "p1");
  assert.equal(r.phase, "round_result");
  assert.equal(total(r).length, 4);
  assert.equal(r.discard.length, 1);
  assert.throws(() => applyPlay(r, "p0", ["0-1"], "2"), /not accepting/);
  nextRound(r);
  assert.equal(r.roundRank, null);
  assert.equal(r.currentTurnIndex, 0);
});
test("mixed challenge: any false selected card catches bluff and preserves the deck", () => {
  const r = fixture([["J", "2", "J", "3", "4"], ["5"]]);
  applyPlay(r, "p0", ["0-0", "0-1", "0-2", "0-3"], "J");
  const result = applyChallenge(r, "p1", [0, 1]);
  assert.equal(result.foundFake, true);
  assert.equal(result.pileCount, 4);
  assert.equal(r.hands.p0.length, 5);
  assert.equal(total(r).length, 6);
});
test("rejects invalid ownership, duplicate cards, wrong turns, and invalid picks", () => {
  const r = fixture([
    ["J", "2"],
    ["3", "4"],
  ]);
  assert.throws(() => applyPlay(r, "p1", ["1-0"], "3"), /not your turn/);
  assert.throws(() => applyPlay(r, "p0", ["1-0"], "J"), /your hand/);
  assert.throws(() => applyPlay(r, "p0", ["0-0", "0-0"], "J"), /Duplicate/);
  applyPlay(r, "p0", ["0-0"], "J");
  assert.throws(() => applyChallenge(r, "p1", [8]), /exactly/);
  assert.throws(() => applyChallenge(r, "p0", [0]), /opponent/);
});
test("simulated games keep cards unique and never leave an empty hand stranded", () => {
  for (let n = 2; n <= 6; n++) {
    const r = room(n);
    startGame(r, createDeck());
    for (let step = 0; step < 1200 && r.phase !== "finished"; step++) {
      if (r.phase === "round_result") {
        nextRound(r);
        continue;
      }
      const id = r.players[r.currentTurnIndex].id;
      const hand = r.hands[id];
      if (r.pendingWinnerId || (r.lastMove && step % 4 === 0)) {
        applyPass(r, id);
      } else if (r.lastMove && step % 7 === 0) {
        applyChallenge(r, id, [0]);
      } else {
        const card = hand[0];
        assert.ok(
          card,
          "active player must have a card unless responding to a final claim",
        );
        applyPlay(r, id, [card.id], r.roundRank || card.rank);
      }
      const cards = total(r);
      assert.equal(cards.length, 52);
      assert.equal(new Set(cards.map((c) => c.id)).size, 52);
      if (r.phase === "playing")
        for (const p of r.players)
          if (!r.hands[p.id].length) assert.equal(r.pendingWinnerId, p.id);
    }
  }
});
