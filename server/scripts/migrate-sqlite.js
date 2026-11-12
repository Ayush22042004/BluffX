require("../src/environment").loadEnvironment();
const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");
const { createDatabase } = require("../src/database");

async function migrate({ sourcePath, database, merge = false }) {
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    const users = source.prepare("SELECT * FROM users").all();
    const sessions = source.prepare("SELECT * FROM sessions").all();
    const tokens = source.prepare("SELECT * FROM tokens").all();
    const inserted = { users: 0, sessions: 0, tokens: 0 };
    const existing = { users: 0, sessions: 0, tokens: 0 };
    const same = (left, right, fields) =>
      fields.every(
        (field) => String(left[field] ?? "") === String(right[field] ?? ""),
      );
    const conflict = () =>
      Object.assign(
        new Error(
          "Existing destination data conflicts with the source. Nothing was overwritten.",
        ),
        { code: "MIGRATION_CONFLICT" },
      );
    await database.transaction(async (tx) => {
      // Refuse to merge identities or overwrite any existing destination data.
      for (const table of merge ? [] : ["users", "sessions", "tokens"]) {
        if (await tx.get(`SELECT * FROM ${table} LIMIT 1`)) {
          throw new Error(
            "Destination must be empty. No account data was copied.",
          );
        }
      }
      for (const u of users) {
        u.tutorial_status ||= "new";
        const prior =
          merge &&
          (await tx.get(
            "SELECT * FROM users WHERE id=? OR email=? OR google_sub=?",
            u.id,
            u.email,
            u.google_sub,
          ));
        if (prior) {
          if (
            !same(prior, u, [
              "id",
              "email",
              "name",
              "avatar",
              "password_hash",
              "google_sub",
              "email_verified",
              "created_at",
              "tutorial_status",
            ])
          )
            throw conflict();
          existing.users++;
          continue;
        }
        await tx.run(
          "INSERT INTO users(id,email,name,avatar,password_hash,google_sub,email_verified,created_at,tutorial_status) VALUES(?,?,?,?,?,?,?,?,?)",
          u.id,
          u.email,
          u.name,
          u.avatar,
          u.password_hash,
          u.google_sub,
          u.email_verified,
          u.created_at,
          u.tutorial_status || "new",
        );
        inserted.users++;
      }
      for (const s of sessions) {
        const prior =
          merge &&
          (await tx.get("SELECT * FROM sessions WHERE hash=?", s.hash));
        if (prior) {
          if (!same(prior, s, ["hash", "user_id", "expires_at"]))
            throw conflict();
          existing.sessions++;
          continue;
        }
        await tx.run(
          "INSERT INTO sessions(hash,user_id,expires_at) VALUES(?,?,?)",
          s.hash,
          s.user_id,
          s.expires_at,
        );
        inserted.sessions++;
      }
      for (const t of tokens) {
        const prior =
          merge && (await tx.get("SELECT * FROM tokens WHERE hash=?", t.hash));
        if (prior) {
          if (!same(prior, t, ["hash", "user_id", "kind", "expires_at"]))
            throw conflict();
          existing.tokens++;
          continue;
        }
        await tx.run(
          "INSERT INTO tokens(hash,user_id,kind,expires_at) VALUES(?,?,?,?)",
          t.hash,
          t.user_id,
          t.kind,
          t.expires_at,
        );
        inserted.tokens++;
      }
    });
    return {
      users: users.length,
      sessions: sessions.length,
      tokens: tokens.length,
      ...(merge ? { inserted, existing } : {}),
    };
  } finally {
    source.close();
  }
}

async function main() {
  const database = await createDatabase({
    connectionString:
      process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL,
  });
  try {
    const counts = await migrate({
      sourcePath: path.resolve(
        process.argv.slice(2).find((arg) => arg !== "--merge") ||
          path.join(__dirname, "../.data/accounts.sqlite"),
      ),
      database,
      merge: process.argv.includes("--merge"),
    });
    console.log(
      `Imported ${counts.users} accounts, ${counts.sessions} sessions and ${counts.tokens} email tokens. SQLite source was left unchanged.`,
    );
    if (counts.inserted)
      console.log(
        JSON.stringify({
          inserted: counts.inserted,
          alreadyPresent: counts.existing,
        }),
      );
  } finally {
    await database.close();
  }
}
if (require.main === module)
  main().catch((error) => {
    // Never print connection strings, password hashes, or tokens.
    console.error(
      "Account migration failed:",
      error.code ||
        (error.message.startsWith("Destination must")
          ? error.message
          : "Check the source path and DATABASE_URL."),
    );
    process.exitCode = 1;
  });
module.exports = { migrate };
