const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { newDb } = require("pg-mem");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createDatabase } = require("../src/database");
const { migrate } = require("../scripts/migrate-sqlite");

test("SQLite import preserves identities, credentials, sessions and tokens without modifying the source", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bluffx-import-test-"));
  const sourcePath = path.join(root, "old.sqlite");
  const source = new DatabaseSync(sourcePath);
  source.exec(`
    CREATE TABLE users(id TEXT, email TEXT, name TEXT, avatar INTEGER, password_hash TEXT, google_sub TEXT, email_verified INTEGER, created_at INTEGER);
    INSERT INTO users VALUES('one','one@example.com','Player',3,'salt:hash','google-one',1,1700000000000);
    CREATE TABLE sessions(hash TEXT,user_id TEXT,expires_at INTEGER);
    INSERT INTO sessions VALUES('session-hash','one',9999999999999);
    CREATE TABLE tokens(hash TEXT,user_id TEXT,kind TEXT,expires_at INTEGER);
    INSERT INTO tokens VALUES('token-hash','one','reset',9999999999999);
  `);
  source.close();
  const before = fs.readFileSync(sourcePath);
  const { Pool } = newDb().adapters.createPg();
  const pool = new Pool();
  const database = await createDatabase({ pool });
  try {
    assert.deepEqual(await migrate({ sourcePath, database }), {
      users: 1,
      sessions: 1,
      tokens: 1,
    });
    const user = await database.get("SELECT * FROM users WHERE id=?", "one");
    assert.equal(user.password_hash, "salt:hash");
    assert.equal(user.google_sub, "google-one");
    assert.equal(user.avatar, 3);
    assert.equal(user.tutorial_status, "new");
    assert.equal(Number(user.created_at), 1700000000000);
    assert.equal(
      (await database.get("SELECT * FROM sessions")).hash,
      "session-hash",
    );
    assert.equal(
      (await database.get("SELECT * FROM tokens")).hash,
      "token-hash",
    );
    assert.deepEqual(fs.readFileSync(sourcePath), before);
    await assert.rejects(
      migrate({ sourcePath, database }),
      /Destination must be empty/,
    );
    const repeated = await migrate({ sourcePath, database, merge: true });
    assert.deepEqual(repeated.inserted, { users: 0, sessions: 0, tokens: 0 });
    assert.deepEqual(repeated.existing, { users: 1, sessions: 1, tokens: 1 });
    await database.run(
      "UPDATE users SET name=? WHERE id=?",
      "Newer Neon Profile",
      "one",
    );
    await assert.rejects(migrate({ sourcePath, database, merge: true }), {
      code: "MIGRATION_CONFLICT",
    });
    assert.equal(
      (await database.get("SELECT name FROM users WHERE id=?", "one")).name,
      "Newer Neon Profile",
    );
  } finally {
    await pool.end();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
