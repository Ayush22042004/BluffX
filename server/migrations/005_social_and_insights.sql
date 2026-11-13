CREATE TABLE IF NOT EXISTS bx_social_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  handle TEXT NOT NULL UNIQUE, requests_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  invites_enabled BOOLEAN NOT NULL DEFAULT TRUE, recent_enabled BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE TABLE IF NOT EXISTS bx_friends (
  sender TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('pending','accepted','declined')),
  updated_at BIGINT NOT NULL, PRIMARY KEY(sender,recipient), CHECK(sender<>recipient)
);
CREATE INDEX IF NOT EXISTS bx_friend_inbox ON bx_friends(recipient,status);
CREATE TABLE IF NOT EXISTS bx_blocks (
  owner TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY(owner,target), CHECK(owner<>target)
);
CREATE TABLE IF NOT EXISTS bx_invites (
  token TEXT PRIMARY KEY, sender TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room_code TEXT NOT NULL, expires_at BIGINT NOT NULL,
  UNIQUE(sender,recipient,room_code)
);
CREATE INDEX IF NOT EXISTS bx_invite_inbox ON bx_invites(recipient,expires_at);
ALTER TABLE bx_matches ADD COLUMN IF NOT EXISTS summary JSONB;
CREATE INDEX IF NOT EXISTS bx_history_user ON bx_results(user_id,match_id);
CREATE INDEX IF NOT EXISTS bx_season_results ON bx_matches(completed_at) WHERE ranked=TRUE AND finalized=TRUE;
CREATE TABLE IF NOT EXISTS bx_achievements (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  achievement TEXT NOT NULL, match_id TEXT NOT NULL REFERENCES bx_matches(match_id),
  unlocked_at BIGINT NOT NULL, PRIMARY KEY(user_id,achievement)
);
REVOKE ALL ON bx_social_profiles,bx_friends,bx_blocks,bx_invites,bx_achievements FROM PUBLIC;
