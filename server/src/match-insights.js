function summary(r) {
  const players = (r.participants || []).map((p) => ({
    id: p.id,
    name: p.name,
    aiAssisted: !!p.aiUsed,
    forfeit: !!p.forfeit,
    ...r.insights[p.id],
  }));
  const awards = [];
  for (const [key, title] of [
    ["unchallengedBluffs", "Master Bluffer"],
    ["challengesWon", "Human Lie Detector"],
    ["challenges", "Risk Taker"],
    ["challengesLost", "Unlucky Challenger"],
  ]) {
    const max = Math.max(0, ...players.map((p) => p[key] || 0));
    if (max >= 2)
      for (const p of players.filter((p) => p[key] === max))
        awards.push({ playerId: p.id, title, count: max });
  }
  return {
    durationMs: Math.max(0, (r.completedAt || r.startedAt) - r.startedAt),
    completedRounds: r.completedRounds || 0,
    deckCount: r.deckCount || 1,
    playerCount: players.length,
    players,
    awards,
    challenges: players.reduce((n, p) => n + (p.challenges || 0), 0),
    challengesWon: players.reduce((n, p) => n + (p.challengesWon || 0), 0),
    challengesLost: players.reduce((n, p) => n + (p.challengesLost || 0), 0),
  };
}
module.exports = { summary };
