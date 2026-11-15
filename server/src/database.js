const { Pool } = require("pg");
const { RULES } = require("./rules");
const { AVATAR_SCHEMA } = require("./avatars");
const { LAUNCH_SCHEMA } = require("./launch-controls");

// Preserve pg 8's certificate/hostname verification explicitly across upgrades.
function verifiedConnectionString(value) {
  if (!value || /[?&]uselibpqcompat=true(?:&|$)/.test(value)) return value;
  return value.replace(
    /([?&]sslmode=)(?:prefer|require|verify-ca)(?=&|$)/,
    "$1verify-full",
  );
}

const schema = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  avatar INTEGER NOT NULL DEFAULT 0, password_hash TEXT, google_sub TEXT UNIQUE,
  email_verified INTEGER NOT NULL DEFAULT 0, created_at BIGINT NOT NULL,
  tutorial_status TEXT NOT NULL DEFAULT 'new'
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS tutorial_status TEXT NOT NULL DEFAULT 'new';
CREATE TABLE IF NOT EXISTS sessions (
  hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens (
  hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS tokens_user_kind_idx ON tokens(user_id, kind);
CREATE INDEX IF NOT EXISTS tokens_expiry_idx ON tokens(expires_at);
${AVATAR_SCHEMA}
${LAUNCH_SCHEMA}
${require("node:fs").readFileSync(require("node:path").join(__dirname, "../migrations/006_report_email.sql"), "utf8").split("REVOKE ALL")[0]}
${require("node:fs").readFileSync(require("node:path").join(__dirname, "../migrations/005_social_and_insights.sql"), "utf8").split("ALTER TABLE bx_matches")[0]}
${require("node:fs").readFileSync(require("node:path").join(__dirname, "../migrations/007_parties.sql"), "utf8").split("REVOKE ALL")[0]}
`;

// SQL here is application-owned; values always travel separately as parameters.
function queries(client) {
  const query = (sql, values) => {
    let index = 0;
    return client.query(
      sql.replace(/\?/g, () => `$${++index}`),
      values,
    );
  };
  return {
    async get(sql, ...values) {
      return (await query(sql, values)).rows[0];
    },
    async run(sql, ...values) {
      return query(sql, values);
    },
  };
}

async function createDatabase({
  connectionString = process.env.DATABASE_URL,
  directConnectionString = process.env.DATABASE_URL_UNPOOLED,
  pool,
} = {}) {
  if (!pool && !connectionString) {
    throw new Error(
      "DATABASE_URL is required. Run neon deploy at the project root or configure server/.env (see docs/authentication.md).",
    );
  }
  const owned = !pool;
  pool ||= new Pool({
    connectionString: verifiedConnectionString(connectionString),
    max: RULES.authPoolSize,
    connectionTimeoutMillis: RULES.storageTimeoutMs,
    query_timeout: RULES.storageTimeoutMs + 5000,
  });
  if (owned)
    pool.on("error", (error) =>
      console.error("PostgreSQL pool error:", error.code || error.name),
    );
  const schemaPool =
    owned &&
    directConnectionString &&
    directConnectionString !== connectionString
      ? new Pool({
          connectionString: verifiedConnectionString(directConnectionString),
          max: 1,
          connectionTimeoutMillis: RULES.storageTimeoutMs,
          query_timeout: RULES.storageTimeoutMs + 5000,
        })
      : pool;
  try {
    await schemaPool.query(schema);
  } catch (error) {
    if (owned) await pool.end();
    throw error;
  } finally {
    if (schemaPool !== pool) await schemaPool.end();
  }
  return {
    ...queries(pool),
    async transaction(work) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await work(queries(client));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      if (owned) await pool.end();
    },
  };
}
module.exports = { createDatabase, verifiedConnectionString };
