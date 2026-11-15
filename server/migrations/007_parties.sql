CREATE TABLE IF NOT EXISTS bx_parties (
  id TEXT PRIMARY KEY,
  host_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS bx_party_members (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  party_id TEXT NOT NULL REFERENCES bx_parties(id) ON DELETE CASCADE,
  joined_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS bx_party_members_party ON bx_party_members(party_id,joined_at,user_id);
CREATE TABLE IF NOT EXISTS bx_party_invites (
  token TEXT PRIMARY KEY,
  party_id TEXT NOT NULL REFERENCES bx_parties(id) ON DELETE CASCADE,
  sender TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at BIGINT NOT NULL,
  UNIQUE(party_id,recipient)
);
CREATE INDEX IF NOT EXISTS bx_party_invites_inbox ON bx_party_invites(recipient,expires_at);
REVOKE ALL ON bx_parties,bx_party_members,bx_party_invites FROM PUBLIC;
