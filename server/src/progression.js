const CATALOG = {
  first_victory: "First Victory",
  five_wins: "Five Wins",
  ten_wins: "Ten Wins",
  ten_matches: "Ten Ranked Matches",
  first_bluff: "First Successful Bluff",
  first_challenge: "First Correct Challenge",
  five_challenges: "Five Successful Challenges",
  perfect_challenges: "Perfect Challenge Match",
  party_player: "Party Player",
  double_trouble: "Double Trouble",
};
function conditions(room, result, stats) {
  if (!result.ranked || result.forfeit || result.aiAssisted) return [];
  const x = room.insights?.[result.playerId],
    wins = Number(stats.wins || 0),
    out = [];
  if (result.won) out.push("first_victory");
  if (wins >= 5) out.push("five_wins");
  if (wins >= 10) out.push("ten_wins");
  if (Number(stats.games) >= 10) out.push("ten_matches");
  if (x?.unchallengedBluffs > 0) out.push("first_bluff");
  if (x?.challengesWon > 0) out.push("first_challenge");
  if (Number(stats.ranked_correct) >= 5) out.push("five_challenges");
  if (x?.challenges >= 3 && x.challengesWon === x.challenges)
    out.push("perfect_challenges");
  if (room.participants.length >= 8) out.push("party_player");
  if (result.won && room.deckCount === 2) out.push("double_trouble");
  return out;
}
async function unlock(client, room, results, now) {
  const eligible = results.filter(
    (r) => r.userId && r.ranked && !r.forfeit && !r.aiAssisted,
  );
  if (!eligible.length) return;
  const stats = (
    await client.query(
      `SELECT s.user_id,s.wins,s.games,COALESCE(c.ranked_correct,0) AS ranked_correct
    FROM bx_player_stats s LEFT JOIN (SELECT user_id,SUM(correct_calls) AS ranked_correct FROM bx_results
    WHERE user_id=ANY($1::text[]) AND ranked=TRUE AND ai_assisted=FALSE AND forfeit=FALSE GROUP BY user_id) c ON c.user_id=s.user_id
    WHERE s.user_id=ANY($1::text[])`,
      [eligible.map((r) => r.userId)],
    )
  ).rows;
  const byUser = new Map(stats.map((s) => [s.user_id, s]));
  const unlocks = eligible.flatMap((r) =>
    conditions(room, r, byUser.get(r.userId) || {}).map((achievement) => ({
      user_id: r.userId,
      achievement,
      match_id: room.matchId,
      unlocked_at: now,
    })),
  );
  if (unlocks.length)
    await client.query(
      `INSERT INTO bx_achievements(user_id,achievement,match_id,unlocked_at)
    SELECT p.user_id,p.achievement,p.match_id,p.unlocked_at FROM jsonb_to_recordset($1::jsonb)
    AS p(user_id text,achievement text,match_id text,unlocked_at bigint) ON CONFLICT DO NOTHING`,
      [JSON.stringify(unlocks)],
    );
}

function season(now = Date.now()) {
  const d = new Date(now),
    year = d.getUTCFullYear(),
    q = Math.floor(d.getUTCMonth() / 3);
  return {
    id: `${year}-Q${q + 1}`,
    start: Date.UTC(year, q * 3, 1),
    end: Date.UTC(year, (q + 1) * 3, 1),
  };
}
module.exports = { CATALOG, conditions, unlock, season };
