// Inventory only. This command never executes migration SQL.
require("../src/environment").loadEnvironment();
const { Client } = require("pg");
const { verifiedConnectionString } = require("../src/database");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
(async () => {
  const client = new Client({
    connectionString: verifiedConnectionString(
      process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL,
    ),
    connectionTimeoutMillis: 10000,
    query_timeout: 10000,
  });
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const table = await client.query(
      "SELECT to_regclass('public.bx_migrations') AS name",
    );
    const rows = table.rows[0].name
      ? (await client.query("SELECT name,checksum FROM bx_migrations")).rows
      : [];
    const applied = new Map(rows.map((r) => [r.name, r.checksum]));
    for (const file of fs
      .readdirSync(path.join(__dirname, "../migrations"))
      .filter((f) => /^\d+_.*\.sql$/.test(f))
      .sort()) {
      const name = file.replace(/\.sql$/, "");
      const digest = crypto
        .createHash("sha256")
        .update(fs.readFileSync(path.join(__dirname, "../migrations", file)))
        .digest("hex");
      const status = !applied.has(name)
        ? "PENDING"
        : applied.get(name) === digest
          ? "APPLIED"
          : "CHECKSUM MISMATCH";
      console.log(status + " " + name);
      if (status === "CHECKSUM MISMATCH") process.exitCode = 1;
    }
    await client.query("COMMIT");
    console.log("Read-only inventory complete. No migrations applied.");
  } finally {
    await client.end();
  }
})().catch(() => {
  console.error(
    "Migration inventory failed; verify database connectivity/configuration.",
  );
  process.exitCode = 1;
});
