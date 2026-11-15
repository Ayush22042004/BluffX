// Bootstrap only an explicitly guarded, disposable integration-test database.
// CI starts with an empty Postgres service, unlike a branch copied from Neon.
require("./real-db-env.cjs");
const { main } = require("../scripts/migrate-games");
main().catch((error) => {
  console.error("Isolated database setup failed:", error.code || error.name);
  process.exitCode = 1;
});
