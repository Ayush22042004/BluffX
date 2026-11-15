ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at BIGINT;
CREATE TABLE IF NOT EXISTS account_erasure (user_id TEXT PRIMARY KEY, requested_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS bx_reports (
  id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  room_code TEXT, match_id TEXT, category TEXT NOT NULL, description TEXT NOT NULL,
  build TEXT NOT NULL, diagnostic JSONB NOT NULL, created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS bx_reports_review ON bx_reports(created_at);
CREATE TABLE IF NOT EXISTS bx_ranked_pairs (
  day TEXT NOT NULL, pair TEXT NOT NULL, games INTEGER NOT NULL,
  PRIMARY KEY(day,pair)
);
REVOKE ALL ON account_erasure,bx_reports,bx_ranked_pairs FROM PUBLIC;
