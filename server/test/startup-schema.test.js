const test = require("node:test");
const assert = require("node:assert/strict");
const pg = require("pg");
let poolClosed = 0,
  ownerClosed = 0,
  ownerConnected = 0;
const queries = [];
pg.Pool = class {
  async query(sql) {
    queries.push(sql);
    throw Object.assign(Error("relation does not exist"), { code: "42P01" });
  }
  async end() {
    poolClosed++;
  }
};
pg.Client = class {
  async connect() {
    ownerConnected++;
  }
  async end() {
    ownerClosed++;
  }
};
const { createGameStore } = require("../src/game-store");
test("an unmigrated database gives actionable startup guidance without writes or ownership changes", async () => {
  await assert.rejects(
    createGameStore({
      connectionString: "postgresql://test@localhost/test",
      directUrl: "postgresql://test@localhost/test",
      autoMigrate: false,
    }),
    (e) => {
      assert.equal(e.code, "MIGRATION_REQUIRED");
      assert.match(e.message, /npm run db:migrate-games/);
      assert.match(e.message, /isolated Neon branch/);
      return true;
    },
  );
  assert.deepEqual(queries, ["SELECT name,checksum FROM bx_migrations"]);
  assert.equal(poolClosed, 1);
  assert.equal(ownerClosed, 1);
  assert.equal(ownerConnected, 0);
});
