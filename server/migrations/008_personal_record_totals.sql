ALTER TABLE bx_player_stats ADD COLUMN IF NOT EXISTS unranked_wins BIGINT NOT NULL DEFAULT 0;
-- Recover existing casual victories from authoritative results, not browser storage.
-- Ranked counters retain their existing competitive meaning.
UPDATE bx_player_stats s SET unranked_wins=(
  SELECT COUNT(*) FROM bx_results r WHERE r.user_id=s.user_id AND r.ranked=FALSE AND r.won=TRUE
);
