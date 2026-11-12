const crypto = require("crypto");
const RANKS = [
  "A",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "J",
  "Q",
  "K",
];
function createDeck() {
  const deck = [];
  for (const suit of ["S", "H", "D", "C"])
    for (const rank of RANKS)
      deck.push({ id: crypto.randomUUID(), rank, suit });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}
const name = (r, id) => r.players.find((p) => p.id === id)?.name || "Player";
const deadline = (r) => {
  r.turnEndsAt =
    r.phase === "playing" ? Date.now() + r.turnSeconds * 1000 : null;
};
function finishGame(r, id) {
  r.phase = "finished";
  r.winnerId = id;
  r.pendingWinnerId = null;
  r.turnEndsAt = null;
  clearTimeout(r.botTimer);
}
function startGame(r, deck) {
  r.hands = Object.fromEntries(r.players.map((p) => [p.id, []]));
  deck.forEach((c, i) => r.hands[r.players[i % r.players.length].id].push(c));
  Object.assign(r, {
    matchId: crypto.randomUUID(),
    phase: "playing",
    pile: [],
    discard: [],
    roundNumber: 1,
    lastMove: null,
    roundRank: null,
    pendingWinnerId: null,
    winnerId: null,
    currentTurnIndex: 0,
    lastResult: null,
  });
  deadline(r);
}
function assertPlaying(r, id, turn = false) {
  if (r.phase !== "playing") throw Error("This round is not accepting moves.");
  if (!r.players.some((p) => p.id === id))
    throw Error("You are not at this table.");
  if (turn && r.players[r.currentTurnIndex]?.id !== id)
    throw Error("It is not your turn.");
}
function advance(r) {
  const claim = r.lastMove;
  for (let step = 1; step <= r.players.length; step++) {
    const i = (r.currentTurnIndex + step) % r.players.length;
    const id = r.players[i].id;
    if (id !== claim?.playerId && !claim?.passedBy.includes(id)) {
      r.currentTurnIndex = i;
      deadline(r);
      return;
    }
  }
}
function applyPlay(r, id, ids, rank) {
  assertPlaying(r, id, true);
  if (r.pendingWinnerId)
    throw Error(
      "Final claim: pass or call bluff before the game can continue.",
    );
  if (!Array.isArray(ids) || !ids.length)
    throw Error("Select at least one card.");
  if (new Set(ids).size !== ids.length)
    throw Error("Duplicate card selection.");
  if (!RANKS.includes(rank) || (r.roundRank && rank !== r.roundRank))
    throw Error("Continue the current rank.");
  const hand = r.hands[id];
  if (ids.some((cid) => !hand.some((c) => c.id === cid)))
    throw Error("You can only play cards in your hand.");
  const selected = new Set(ids),
    cards = hand.filter((c) => selected.has(c.id));
  r.hands[id] = hand.filter((c) => !selected.has(c.id));
  r.pile.push(...cards);
  r.roundRank = rank;
  r.lastMove = {
    playerId: id,
    cards,
    declaredRank: rank,
    passedBy: [],
    ts: Math.max(Date.now(), (r.lastMove?.ts || 0) + 1),
  };
  if (!r.hands[id].length) r.pendingWinnerId = id;
  advance(r);
  return null;
}
function closeRound(r, result, starter) {
  r.lastResult = { ...result, roundNumber: r.roundNumber };
  r.lastMove = null;
  r.roundRank = null;
  r.pendingWinnerId = null;
  r.currentTurnIndex = Math.max(
    0,
    r.players.findIndex((p) => p.id === starter),
  );
  r.phase = "round_result";
  r.turnEndsAt = null;
  clearTimeout(r.botTimer);
}
function nextRound(r) {
  r.roundNumber++;
  r.phase = "playing";
  r.lastResult = null;
  deadline(r);
}
function applyPass(r, id) {
  assertPlaying(r, id, true);
  const claim = r.lastMove;
  if (!claim || claim.playerId === id || claim.passedBy.includes(id))
    throw Error("There is no claim you can pass.");
  claim.passedBy.push(id);
  if (claim.passedBy.length === r.players.length - 1) {
    if (r.pendingWinnerId) {
      const winner = r.pendingWinnerId;
      finishGame(r, winner);
      return {
        type: "pass",
        message: `${name(r, winner)} wins! Their final claim survived the table.`,
      };
    }
    const starter = claim.playerId;
    r.discard.push(...r.pile);
    r.pile = [];
    const result = {
      type: "pass",
      message: `Everyone passed. The pile clears and ${name(r, starter)} starts the next round.`,
      revealCards: [],
      starterId: starter,
    };
    closeRound(r, result, starter);
    return result;
  }
  advance(r);
  return {
    type: "pass",
    message: `${name(r, id)} passed. ${r.players.length - 1 - claim.passedBy.length} more passes to close this claim.`,
  };
}
function applyChallenge(r, id, indexes) {
  assertPlaying(r, id);
  const claim = r.lastMove;
  if (!claim || claim.playerId === id)
    throw Error("There is no opponent claim to challenge.");
  if (claim.passedBy.includes(id))
    throw Error("You already passed this claim.");
  const required = Math.max(1, Math.floor(claim.cards.length / 2));
  if (
    !Array.isArray(indexes) ||
    indexes.length !== required ||
    new Set(indexes).size !== indexes.length ||
    indexes.some(
      (i) => !Number.isInteger(i) || i < 0 || i >= claim.cards.length,
    )
  )
    throw Error(`Choose exactly ${required} face-down cards.`);
  const revealCards = indexes.map((i) => ({
      ...claim.cards[i],
      isFake: claim.cards[i].rank !== claim.declaredRank,
    })),
    fake = revealCards.some((c) => c.isFake),
    loserId = fake ? claim.playerId : id,
    winnerId = fake ? id : claim.playerId,
    pileCount = r.pile.length,
    pending = r.pendingWinnerId;
  r.hands[loserId].push(...r.pile);
  r.pile = [];
  const result = {
    type: fake ? "caller_correct" : "caller_wrong",
    foundFake: fake,
    callerId: id,
    callerName: name(r, id),
    blufferId: claim.playerId,
    blufferName: name(r, claim.playerId),
    loserId,
    loserName: name(r, loserId),
    winnerId,
    winnerName: name(r, winnerId),
    declaredRank: claim.declaredRank,
    cardCount: claim.cards.length,
    pileCount,
    revealCards,
    message: `${fake ? "Bluff caught!" : "The claim was true."} ${name(r, loserId)} picks up ${pileCount} card${pileCount === 1 ? "" : "s"}.`,
  };
  closeRound(r, result, winnerId);
  // A defended final claim wins immediately; a caught final bluff receives the pile.
  if (pending && r.hands[pending].length === 0) finishGame(r, pending);
  return result;
}
function publicState(r, id) {
  const claim = r.lastMove;
  return {
    matchId: r.matchId,
    roomId: r.id,
    roomName: r.roomName,
    phase: r.phase,
    hostId: r.hostId,
    players: r.players,
    you: r.players.find((p) => p.id === id),
    hand: r.hands[id] || [],
    playerHandsCount: Object.fromEntries(
      r.players.map((p) => [p.id, r.hands[p.id]?.length || 0]),
    ),
    currentTurnId: r.players[r.currentTurnIndex]?.id,
    currentTurnName: r.players[r.currentTurnIndex]?.name,
    pileCount: r.pile.length,
    roundRank: r.roundRank,
    roundNumber: r.roundNumber,
    lastMove: claim
      ? {
          playerId: claim.playerId,
          playerName: name(r, claim.playerId),
          declaredRank: claim.declaredRank,
          cardCount: claim.cards.length,
          requiredPickCount: Math.max(1, Math.floor(claim.cards.length / 2)),
          passedBy: claim.passedBy,
          ts: claim.ts,
        }
      : null,
    pendingWinnerId: r.pendingWinnerId,
    winnerId: r.winnerId,
    turnEndsAt: r.turnEndsAt,
    mode: r.mode,
    maxPlayers: r.maxPlayers,
    turnSeconds: r.turnSeconds,
    isPrivate: !!r.password,
    lastResult: r.lastResult,
  };
}
module.exports = {
  createDeck,
  startGame,
  finishGame,
  applyPlay,
  applyPass,
  applyChallenge,
  nextRound,
  publicState,
};
