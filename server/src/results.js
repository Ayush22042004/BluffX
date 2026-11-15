function finalResults(room) {
  const participants = room.participants || [];
  const winner = participants.find((p) => p.id === room.winnerId);
  const ranked =
    room.mode === "multiplayer" &&
    process.env.PLAYTEST_UNRANKED !== "true" &&
    room.rankEligibility !== false &&
    !room.rules?.playtestUnranked &&
    (!room.rules?.requireVerifiedRanked ||
      participants.filter((p) => !p.isBot).every((p) => p.emailVerified)) &&
    participants.filter((p) => p.accountId && !p.isBot).length >= 2 &&
    !participants.some((p) => p.isBot) &&
    !!winner?.accountId &&
    !winner.aiUsed &&
    !room.abandoned;
  const order = [...participants].sort((a, b) => {
    if (a.id === room.winnerId) return -1;
    if (b.id === room.winnerId) return 1;
    if (!!a.forfeit !== !!b.forfeit) return a.forfeit ? 1 : -1;
    return a.forfeit
      ? (b.eliminatedAt || 0) - (a.eliminatedAt || 0)
      : (room.hands[a.id]?.length || 0) - (room.hands[b.id]?.length || 0);
  });
  let placement = 0,
    priorKey;
  return order.map((p, index) => {
    const won = p.id === room.winnerId;
    const key = won
      ? "winner"
      : p.forfeit
        ? `forfeit:${p.eliminatedAt}`
        : `cards:${room.hands[p.id]?.length || 0}`;
    if (key !== priorKey) placement = index + 1;
    priorKey = key;
    return {
      playerId: p.id,
      userId: p.accountId || null,
      placement,
      won,
      forfeit: !!p.forfeit,
      aiAssisted: !!p.aiUsed,
      ranked,
      score: room.matchScores?.[p.id] || 0,
      calls: p.calls || 0,
      correct: p.correctCalls || 0,
      reason: p.forfeit
        ? p.forfeitReason || "forfeit"
        : won && p.aiUsed
          ? "ai_assisted"
          : room.winReason || "cards",
    };
  });
}

module.exports = { finalResults };
