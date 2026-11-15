CREATE TABLE IF NOT EXISTS bx_migrations (
  name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS bx_service_owner (
  id INTEGER PRIMARY KEY CHECK(id=1), epoch BIGINT NOT NULL
);
INSERT INTO bx_service_owner(id,epoch) VALUES(1,0) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS bx_rooms (
  room_code TEXT PRIMARY KEY, version BIGINT NOT NULL, schema_version INTEGER NOT NULL,
  status TEXT NOT NULL, state JSONB NOT NULL, checksum TEXT NOT NULL,
  next_deadline BIGINT, updated_at BIGINT NOT NULL, completed_at BIGINT
);
CREATE INDEX IF NOT EXISTS bx_rooms_recovery ON bx_rooms(status, updated_at);
CREATE INDEX IF NOT EXISTS bx_rooms_retention ON bx_rooms(completed_at);
CREATE TABLE IF NOT EXISTS bx_actions (
  room_code TEXT NOT NULL REFERENCES bx_rooms(room_code) ON DELETE CASCADE,
  player_id TEXT NOT NULL, action_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
  acknowledgement JSONB NOT NULL, created_at BIGINT NOT NULL,
  PRIMARY KEY(room_code, player_id, action_id)
);
CREATE TABLE IF NOT EXISTS bx_matches (
  match_id TEXT PRIMARY KEY, room_code TEXT NOT NULL, mode TEXT NOT NULL,
  started_at BIGINT NOT NULL, completed_at BIGINT, rounds INTEGER NOT NULL DEFAULT 0,
  winner_id TEXT, outcome_reason TEXT, ranked BOOLEAN NOT NULL DEFAULT FALSE,
  finalized BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE UNIQUE INDEX IF NOT EXISTS bx_actions_actor_id ON bx_actions(player_id,action_id);
CREATE INDEX IF NOT EXISTS bx_matches_completed ON bx_matches(completed_at);
CREATE TABLE IF NOT EXISTS bx_participants (
  match_id TEXT NOT NULL REFERENCES bx_matches(match_id), player_id TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL, name TEXT NOT NULL,
  avatar INTEGER NOT NULL, is_bot BOOLEAN NOT NULL, joined_at BIGINT NOT NULL,
  PRIMARY KEY(match_id,player_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS bx_one_account_per_match ON bx_participants(match_id,user_id) WHERE user_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS bx_results (
  match_id TEXT NOT NULL, player_id TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  placement INTEGER NOT NULL, won BOOLEAN NOT NULL, forfeit BOOLEAN NOT NULL,
  ai_assisted BOOLEAN NOT NULL, ranked BOOLEAN NOT NULL, score INTEGER NOT NULL,
  calls INTEGER NOT NULL, correct_calls INTEGER NOT NULL, outcome_reason TEXT NOT NULL,
  PRIMARY KEY(match_id,player_id),
  FOREIGN KEY(match_id,player_id) REFERENCES bx_participants(match_id,player_id)
);
CREATE TABLE IF NOT EXISTS bx_player_stats (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  games BIGINT NOT NULL DEFAULT 0, wins BIGINT NOT NULL DEFAULT 0,
  losses BIGINT NOT NULL DEFAULT 0, forfeits BIGINT NOT NULL DEFAULT 0,
  ai_assisted BIGINT NOT NULL DEFAULT 0, unranked_games BIGINT NOT NULL DEFAULT 0,
  calls BIGINT NOT NULL DEFAULT 0, correct_calls BIGINT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS bx_leaderboard_order ON bx_player_stats(wins DESC,games ASC,user_id);
REVOKE ALL ON bx_rooms,bx_actions,bx_service_owner,bx_matches,bx_participants,bx_results,bx_player_stats,bx_migrations FROM PUBLIC;
