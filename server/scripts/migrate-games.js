require("../src/environment").loadEnvironment();
const { Pool } = require("pg");
const { verifiedConnectionString, createDatabase } = require("../src/database");
const { migrateGames } = require("../src/game-store");
async function main() {
  const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!url) throw Error("DATABASE_URL_UNPOOLED is required for migrations.");
  if (/-pooler\./.test(new URL(url).hostname))
    throw Error("Use DATABASE_URL_UNPOOLED for migrations.");
  // Reuse the additive account schema on a fresh database; never replace users.
  const accounts = await createDatabase({
    connectionString: url,
    directConnectionString: url,
  });
  await accounts.close();
  const pool = new Pool({
    connectionString: verifiedConnectionString(url),
    max: 1,
  });
  try {
    await migrateGames(pool);
    console.log(
      "Game migrations applied and verified. Existing accounts unchanged.",
    );
  } finally {
    await pool.end();
  }
}
if (require.main === module)
  main().catch((e) => {
    console.error("Game migration failed:", e.code || e.name);
    process.exitCode = 1;
  });
module.exports = { main };
