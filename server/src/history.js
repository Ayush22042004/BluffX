const { season, CATALOG } = require("./progression");
function installHistory({ app, auth, store }) {
  const route = (url, fn) =>
    app.get("/auth/" + url, async (req, res) => {
      try {
        res.set("Cache-Control", "no-store");
        const s = await auth.sessionFromCookie(req.headers.cookie);
        if (!s)
          return res.status(401).json({ message: "Please sign in again." });
        if (!store.pool)
          return res.json({ items: [], page: 0, hasMore: false });
        const page = Math.min(
          1000,
          Math.max(0, Number.parseInt(req.query.page, 10) || 0),
        );
        await fn(req, res, s.user.id, page);
      } catch {
        res
          .status(503)
          .json({ message: "Player records are temporarily unavailable." });
      }
    });
  route("history", async (req, res, id, page) => {
    const rows = (
      await store.pool.query(
        `SELECT m.match_id,m.mode,m.started_at,m.completed_at,m.rounds,m.ranked,m.summary,r.placement,r.won,r.forfeit,r.ai_assisted,m.outcome_reason,
        CASE WHEN r.won THEN 'You' WHEN wp.recent_enabled=TRUE AND wu.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM bx_blocks b WHERE (b.owner=$1 AND b.target=w.user_id) OR (b.target=$1 AND b.owner=w.user_id)) THEN wu.name ELSE 'Private player' END AS winner_name,
        (SELECT jsonb_agg(CASE WHEN p.user_id=$1 THEN 'You' WHEN p.is_bot=TRUE THEN p.name WHEN sp.recent_enabled=TRUE AND u.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM bx_blocks b WHERE (b.owner=$1 AND b.target=p.user_id) OR (b.target=$1 AND b.owner=p.user_id)) THEN u.name ELSE 'Private player' END) FROM bx_participants p LEFT JOIN bx_social_profiles sp ON sp.user_id=p.user_id LEFT JOIN users u ON u.id=p.user_id WHERE p.match_id=m.match_id) AS participants
        FROM bx_results r JOIN bx_matches m ON m.match_id=r.match_id LEFT JOIN bx_participants w ON w.match_id=m.match_id AND w.player_id=m.winner_id LEFT JOIN bx_social_profiles wp ON wp.user_id=w.user_id LEFT JOIN users wu ON wu.id=w.user_id
        WHERE r.user_id=$1 AND m.finalized=TRUE ORDER BY m.completed_at DESC,m.match_id LIMIT 21 OFFSET $2`,
        [id, page * 20],
      )
    ).rows;
    // Public names are privacy-filtered; never return account/seat IDs, room codes or private histories.
    const items = rows.slice(0, 20).map(({ summary, ...r }) => ({
      ...r,
      deckCount: summary?.deckCount ?? null,
      playerCount: summary?.playerCount ?? null,
      durationMs: summary?.durationMs ?? null,
    }));
    res.json({ items, page, hasMore: rows.length > 20 });
  });
  route("achievements", async (req, res, id) => {
    const items = (
      await store.pool.query(
        "SELECT achievement,unlocked_at FROM bx_achievements WHERE user_id=$1 ORDER BY unlocked_at DESC LIMIT 100",
        [id],
      )
    ).rows.map((r) => ({
      ...r,
      title: CATALOG[r.achievement] || r.achievement,
    }));
    res.json({ items });
  });
  route("season", async (req, res, id, page) => {
    const current = season(),
      min = req.query.sort === "rate" ? 10 : 1,
      friends = req.query.view === "friends";
    const rows = (
      await store.pool.query(
        `WITH totals AS (SELECT r.user_id,COUNT(*) AS games,SUM(CASE WHEN r.won THEN 1 ELSE 0 END) AS wins FROM bx_results r JOIN bx_matches m ON m.match_id=r.match_id WHERE m.completed_at>=$1 AND m.completed_at<$2 AND m.finalized=TRUE AND m.ranked=TRUE AND r.ranked=TRUE AND r.user_id IS NOT NULL GROUP BY r.user_id), ranked AS (SELECT u.name,u.avatar,t.games,t.wins,ROUND(100.0*t.wins/t.games) AS win_rate,RANK() OVER(ORDER BY ${min === 10 ? "(t.wins::numeric/t.games) DESC,t.wins DESC" : "t.wins DESC,(t.wins::numeric/t.games) DESC"}) AS rank FROM totals t JOIN users u ON u.id=t.user_id WHERE t.games>=$3 AND u.deleted_at IS NULL AND ($4=FALSE OR t.user_id=$5 OR EXISTS(SELECT 1 FROM bx_friends f WHERE f.status='accepted' AND ((f.sender=$5 AND f.recipient=t.user_id) OR (f.recipient=$5 AND f.sender=t.user_id)))) AND NOT EXISTS(SELECT 1 FROM bx_blocks b WHERE (b.owner=$5 AND b.target=t.user_id) OR (b.target=$5 AND b.owner=t.user_id))) SELECT * FROM ranked ORDER BY rank,name LIMIT 21 OFFSET $6`,
        [current.start, current.end, min, friends, id, page * 20],
      )
    ).rows;
    res.json({
      season: current,
      items: rows.slice(0, 20),
      hasMore: rows.length > 20,
      page,
      minimumGames: min,
    });
  });
}
module.exports = { installHistory };
