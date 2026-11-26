require("./postgres-fixture.cjs");
const test = require("node:test"), assert = require("node:assert/strict");
const { createAuth } = require("../src/auth");
const flush = () => new Promise(setImmediate);
test("authentication performs no scheduled SQL while idle; expired data is cleaned once after real activity", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: Date.now() });
  const auth = await createAuth({ databaseUrl: "postgresql://test-only", allowedOrigins: new Set(), mailer: { mode: "local", send: async () => ({ local: true }) } });
  try {
    const before = auth.database.queryCount;
    t.mock.timers.tick(24 * 3600000);
    for (let i = 0; i < 10; i++) await flush();
    assert.equal(auth.database.queryCount, before, "idle cleanup must never keep Neon awake");
    await auth.database.get("SELECT COUNT(*) AS n FROM users");
    for (let i = 0; i < 15; i++) await flush();
    const after = auth.database.queryCount;
    assert.equal(after - before, 6, "one requested read plus five maintenance queries");
    t.mock.timers.tick(60000); await flush();
    assert.equal(auth.database.queryCount, after);
    await auth.database.get("SELECT COUNT(*) AS n FROM users"); await flush();
    assert.equal(auth.database.queryCount, after + 1, "maintenance must not recursively reschedule itself");
  } finally { await auth.close(); }
});
