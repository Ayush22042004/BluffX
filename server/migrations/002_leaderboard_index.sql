CREATE INDEX IF NOT EXISTS bx_leaderboard_score
  ON bx_player_stats(wins DESC, ((wins::numeric / NULLIF(games,0))) DESC, user_id)
  WHERE games>0;
