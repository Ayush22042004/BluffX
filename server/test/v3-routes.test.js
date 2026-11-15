require("./postgres-fixture.cjs");
const test = require("node:test"),
  assert = require("node:assert/strict");
const { startServer } = require("../src/index");
test("new social/history reads are throttled before database work without throttling health or game writes", async () => {
  const instance = await startServer({ port: 0 }),
    base = "http://localhost:" + instance.server.address().port;
  try {
    let limited = 0;
    for (let i = 0; i < 45; i++) {
      const r = await fetch(base + "/auth/history");
      if (r.status === 429) {
        limited++;
        const data = await r.json();
        assert.equal(data.code, "RATE_LIMITED");
        assert.ok(data.retryAfterMs > 0);
      } else assert.equal(r.status, 401);
    }
    assert.ok(limited >= 10);
    assert.equal(instance.store.commitCount, 0);
    assert.equal((await fetch(base + "/health")).status, 200);
  } finally {
    await instance.close();
  }
});
