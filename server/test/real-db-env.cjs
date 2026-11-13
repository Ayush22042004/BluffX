// Never load the application's production .env for integration tests.
// CI must explicitly supply both an isolated URL and its expected hostname.
const fs = require("node:fs");
const path = require("node:path");
const file = path.join(__dirname, "../.data/reliability-db.json");
const local = fs.existsSync(file)
  ? JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""))
  : {};
const url = process.env.TEST_DATABASE_URL || local.url;
const expectedHost = process.env.TEST_DATABASE_HOST || "ep-royal-hill-beqtb7ye";
if (
  !url ||
  !(
    new URL(url).hostname === expectedHost ||
    new URL(url).hostname.startsWith(expectedHost + ".")
  )
)
  throw Error(
    "Provide TEST_DATABASE_URL and TEST_DATABASE_HOST for an isolated, disposable database.",
  );
process.env.TEST_DATABASE_URL = url;
process.env.DATABASE_URL = url;
process.env.DATABASE_URL_UNPOOLED = url;
process.env.GAME_AUTO_MIGRATE = "false";
process.env.MAIL_PROVIDER = "local";
process.env.NODE_ENV = "development";
process.env.PLAYTEST_INVITE_ONLY='false';
process.env.PLAYTEST_UNRANKED='false';
process.env.RANKED_PAIR_DAILY_LIMIT='3';
