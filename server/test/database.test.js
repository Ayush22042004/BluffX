const test = require("node:test");
const assert = require("node:assert/strict");
const { createDatabase } = require("../src/database");

test("missing PostgreSQL configuration fails instead of using temporary accounts", async () => {
  await assert.rejects(
    createDatabase({ connectionString: "" }),
    /DATABASE_URL is required/,
  );
});

test("transactions use one connection, parameterize values, rollback and release on failure", async () => {
  const calls = [];
  let released = 0;
  const client = {
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows: [{ id: "one" }] };
    },
    release() {
      released++;
    },
  };
  const pool = {
    async query() {
      return { rows: [] };
    },
    async connect() {
      return client;
    },
  };
  const db = await createDatabase({ pool });
  const hostile = "'; DELETE FROM users; --";
  await assert.rejects(
    db.transaction(async (tx) => {
      assert.equal(
        (await tx.get("SELECT id FROM users WHERE email=?", hostile)).id,
        "one",
      );
      throw Error("abort");
    }),
    /abort/,
  );
  assert.deepEqual(
    calls.map((c) => c.sql),
    ["BEGIN", "SELECT id FROM users WHERE email=$1", "ROLLBACK"],
  );
  assert.deepEqual(calls[1].values, [hostile]);
  assert.equal(released, 1);
  calls.length = 0;
  assert.equal(
    await db.transaction(async (tx) => {
      await tx.run("DELETE FROM sessions WHERE hash=?", "hash");
      return 42;
    }),
    42,
  );
  assert.deepEqual(
    calls.map((c) => c.sql),
    ["BEGIN", "DELETE FROM sessions WHERE hash=$1", "COMMIT"],
  );
  assert.equal(released, 2);
});
