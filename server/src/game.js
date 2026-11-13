const crypto = require("crypto");
const { RULES } = require("./rules");
const { finalResults } = require("./results");
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
function createDeck(deckCount = 1) {
  if (![1, 2].includes(deckCount)) throw Error("Choose one or two decks.");
  const deck = [];
  for (let copy = 0; copy < deckCount; copy++)
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
const deadline = (r, now = Date.now()) => {
  r.turnEndsAt = r.phase === "playing" ? now + r.turnSeconds * 1000 : null;
};
function finishGame(r, id, now = Date.now(), force = false) {
  const player = r.players.find((p) => p.id === id);
  if (
    !force &&
    player &&
    !player.isBot &&
    (player.aiTakeover || player.connected === false)
  ) {
    player.aiUsed = true;
    r.phase = "provisional";
    r.provisional = {
      candidateId: id,
      deadline: now + (r.rules || RULES).provisionalMs,
    };
    r.winnerId = null;
    r.pendingWinnerId = null;
    r.turnEndsAt = null;
    r.pause = null;
    return;
  }
  r.provisional = null;
  r.completedAt = now;
  r.winReason ||= player?.aiUsed ? "ai_assisted" : "cards";
  r.phase = "finished";
  r.winnerId = id;
  r.pendingWinnerId = null;
  r.turnEndsAt = null;
  r.pause = null;
  clearTimeout(r.botTimer);
}
function startGame(r, deck, now = Date.now()) {
  r.hands = Object.fromEntries(r.players.map((p) => [p.id, []]));
  deck.forEach((c, i) => r.hands[r.players[i % r.players.length].id].push(c));
  Object.assign(r, {
    matchId: crypto.randomUUID(),
    phase: "playing",
    rematchRequested: [],
    pile: [],
    discard: [],
    roundNumber: 1,
    lastMove: null,
    roundRank: null,
    pendingWinnerId: null,
    winnerId: null,
    currentTurnIndex: 0,
    lastResult: null,
    completedRounds: 0,
    winReason: null,
    pause: null,
    presenceEvents: [],
    startedAt: now,
    completedAt: null,
    insights: Object.fromEntries(
      r.players.map((p) => [
        p.id,
        {
          cardsPlayed: 0,
          claims: 0,
          challenges: 0,
          challengesWon: 0,
          challengesLost: 0,
          unchallengedBluffs: 0,
          caughtBluffing: 0,
        },
      ]),
    ),
    roundId: crypto.randomUUID(),
    turnSequence: 1,
    claimSequence: 0,
    matchScores: Object.fromEntries(r.players.map((p) => [p.id, 0])),
    roundScores: [],
    participants: r.players.map((p) => ({
      id: p.id,
      accountId: p.accountId || null,
      emailVerified: !!p.emailVerified,
      name: p.name,
      avatar: p.avatar || 0,
      avatarId: p.avatarId || null,
      isBot: !!p.isBot,
      joinedAt: now,
      aiUsed: false,
      calls: 0,
      correctCalls: 0,
    })),
    rankReason: null,
  });
  delete r.rankEligibility;
  deadline(r, now);
}
function assertPlaying(r, id, turn = false) {
  if (r.pause)
    throw Error("The clock is paused while an offline player reconnects.");
  if (r.phase !== "playing") throw Error("This round is not accepting moves.");
  if (!r.players.some((p) => p.id === id))
    throw Error("You are not at this table.");
  if (turn && r.players[r.currentTurnIndex]?.id !== id)
    throw Object.assign(Error("It is not your turn."), {
      code: "NOT_YOUR_TURN",
    });
}
function advance(r, now = Date.now()) {
  const claim = r.lastMove;
  for (let step = 1; step <= r.players.length; step++) {
    const i = (r.currentTurnIndex + step) % r.players.length;
    const id = r.players[i].id;
    if (id !== claim?.playerId && !claim?.passedBy.includes(id)) {
      r.currentTurnIndex = i;
      r.turnSequence = (r.turnSequence || 0) + 1;
      deadline(r, now);
      return;
    }
  }
}
function applyPlay(r, id, ids, rank, now = Date.now()) {
  assertPlaying(r, id, true);
  if (r.pendingWinnerId)
    throw Error(
      "Final claim: pass or call bluff before the game can continue.",
    );
  if (!Array.isArray(ids) || !ids.length)
    throw Error("Select at least one card.");
  if (ids.length > (r.rules || RULES).maxCards)
    throw Object.assign(
      Error(`Play at most ${(r.rules || RULES).maxCards} cards.`),
      { code: "INVALID_CLAIM" },
    );
  if (new Set(ids).size !== ids.length)
    throw Error("Duplicate card selection.");
  if (!RANKS.includes(rank) || (r.roundRank && rank !== r.roundRank))
    throw Error("Continue the current rank.");
  const hand = r.hands[id];
  if (ids.some((cid) => !hand.some((c) => c.id === cid)))
    throw Error("You can only play cards in your hand.");
  const selected = new Set(ids),
    cards = hand.filter((c) => selected.has(c.id));
  if (r.insights?.[id]) {
    r.insights[id].cardsPlayed += cards.length;
    r.insights[id].claims++;
  }
  r.hands[id] = hand.filter((c) => !selected.has(c.id));
  r.pile.push(...cards);
  r.roundRank = rank;
  r.claimSequence = (r.claimSequence || 0) + 1;
  r.lastMove = {
    playerId: id,
    cards,
    declaredRank: rank,
    passedBy: [],
    ts: Math.max(now, (r.lastMove?.ts || 0) + 1),
  };
  if (!r.hands[id].length) r.pendingWinnerId = id;
  advance(r, now);
  return null;
}
function closeRound(r, result, starter, now = Date.now()) {
  r.resultDeadline = now + (r.rules || RULES).resultMs;
  r.turnSequence = (r.turnSequence || 0) + 1;
  r.matchScores ||= {};
  r.roundScores ||= [];
  const scored = result.winnerId || starter;
  r.matchScores[scored] = (r.matchScores[scored] || 0) + 1;
  r.roundScores.push({ round: r.roundNumber, playerId: scored, score: 1 });
  r.roundScores = r.roundScores.slice(
    -((r.rules || RULES).historyLimit || 128),
  );
  r.completedRounds = (r.completedRounds || 0) + 1;
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
function nextRound(r, now = Date.now()) {
  r.roundId = crypto.randomUUID();
  r.turnSequence = (r.turnSequence || 0) + 1;
  r.resultDeadline = null;
  r.roundNumber++;
  r.phase = "playing";
  r.lastResult = null;
  deadline(r, now);
}
function applyPass(r, id, now = Date.now()) {
  assertPlaying(r, id, true);
  const claim = r.lastMove;
  if (!claim || claim.playerId === id || claim.passedBy.includes(id))
    throw Error("There is no claim you can pass.");
  claim.passedBy.push(id);
  if (claim.passedBy.length === r.players.length - 1) {
    if (
      r.insights?.[claim.playerId] &&
      claim.cards.some((c) => c.rank !== claim.declaredRank)
    )
      r.insights[claim.playerId].unchallengedBluffs++;
    if (r.pendingWinnerId) {
      const winner = r.pendingWinnerId;
      finishGame(r, winner, now);
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
    closeRound(r, result, starter, now);
    return result;
  }
  advance(r, now);
  return {
    type: "pass",
    message: `${name(r, id)} passed. ${r.players.length - 1 - claim.passedBy.length} more passes to close this claim.`,
  };
}
function applyChallenge(r, id, indexes, now = Date.now()) {
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
  if (r.insights?.[id]) {
    r.insights[id].challenges++;
    r.insights[id][fake ? "challengesWon" : "challengesLost"]++;
  }
  if (fake && r.insights?.[claim.playerId])
    r.insights[claim.playerId].caughtBluffing++;
  const caller = r.players.find((p) => p.id === id);
  caller.calls = (caller.calls || 0) + 1;
  caller.correctCalls = (caller.correctCalls || 0) + (fake ? 1 : 0);
  closeRound(r, result, winnerId, now);
  // A defended final claim wins immediately; a caught final bluff receives the pile.
  if (pending && r.hands[pending].length === 0) finishGame(r, pending, now);
  return result;
}
function publicState(r, id) {
  const claim = r.lastMove;
  const players = r.players.map((p, index) => ({
    id: p.id,
    name: p.name,
    avatar: p.avatar,
    avatarId: p.avatarId || null,
    seatNumber: index + 1,
    ready: p.ready,
    isBot: p.isBot,
    connected: p.connected !== false,
    aiTakeover: !!p.aiTakeover,
    graceUntil: p.graceUntil || null,
    afkStrikes: p.afkStrikes || 0,
    aiUsed: !!p.aiUsed,
    controlReason: p.controlReason || null,
    controllerState:
      p.controllerState ||
      require("./presence").controllerState(p, (r.rules || RULES).afkStrikes),
    aiRoundsRemaining: p.aiTakeover
      ? Math.max(
          0,
          (r.rules || RULES).aiRounds -
            (p.aiRoundsUsed || 0) -
            ((r.completedRounds || 0) -
              (p.takeoverRound ?? r.completedRounds ?? 0)),
        )
      : null,
  }));
  return {
    serverNow: Date.now(),
    version: r.version || 0,
    roundId: r.roundId || null,
    turnSequence: r.turnSequence || 0,
    claimSequence: r.claimSequence || 0,
    resultDeadline: r.resultDeadline || null,
    provisional: r.provisional
      ? {
          candidateId: r.provisional.candidateId,
          deadline: r.provisional.deadline,
        }
      : null,
    rules: {
      playtestUnranked:
        !!r.rules?.playtestUnranked || process.env.PLAYTEST_UNRANKED === "true",
      requireVerifiedRanked: !!r.rules?.requireVerifiedRanked,
      maxCards: (r.rules || RULES).maxCards,
      graceMs: (r.rules || RULES).graceMs,
      aiRounds: (r.rules || RULES).aiRounds,
      afkStrikes: (r.rules || RULES).afkStrikes,
      resultMs: (r.rules || RULES).resultMs,
      provisionalMs: (r.rules || RULES).provisionalMs,
    },
    matchScores: r.matchScores || {},
    rematchRequests: r.rematchRequested || [],
    matchId: r.matchId,
    roomId: r.id,
    roomName: r.roomName,
    phase: r.phase,
    hostId: r.hostId,
    players,
    you: players.find((p) => p.id === id),
    pause: r.pause
      ? { until: r.pause.until, remainingMs: r.pause.remainingMs }
      : null,
    presenceEvents: r.presenceEvents || [],
    winReason: r.winReason || null,
    resultRanked: r.phase === "finished" ? !!finalResults(r)[0]?.ranked : null,
    rankReason: r.rankReason || null,
    standings:
      r.phase === "finished"
        ? finalResults(r).map((result) => {
            const p =
              (r.participants || []).find((p) => p.id === result.playerId) ||
              r.players.find((p) => p.id === result.playerId);
            return {
              id: result.playerId,
              name: p?.name || "Player",
              avatar: p?.avatar || 0,
              avatarId: p?.avatarId || null,
              isBot: !!p?.isBot,
              placement: result.placement,
              forfeit: result.forfeit,
              aiAssisted: result.aiAssisted,
              score: result.score,
              cardsLeft: r.hands[result.playerId]?.length ?? null,
              outcomeReason: result.reason,
            };
          })
        : null,
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
    deckCount: r.deckCount || 1,
    preset: r.preset || "custom",
    voiceEnabled: r.voiceEnabled !== false,
    aiStyle: r.aiStyle || "balanced",
    matchSummary:
      r.phase === "finished" && r.insights
        ? require("./match-insights").summary(r)
        : null,
    isPrivate: !!(r.passwordHash || r.password),
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
