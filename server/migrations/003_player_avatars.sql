CREATE TABLE IF NOT EXISTS player_avatars (
  id TEXT PRIMARY KEY,
  user_id TEXT UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  guest_hash TEXT UNIQUE,
  image BYTEA NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS player_avatars_expiry ON player_avatars(created_at) WHERE user_id IS NULL;
REVOKE ALL ON player_avatars FROM PUBLIC;
