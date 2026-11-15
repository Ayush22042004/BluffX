const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { startMaintenance } = require("../scripts/maintenance");
test("maintenance handoff answers platform health but refuses auth and game traffic", async () => {
  const server = startMaintenance(0);
  await once(server, "listening");
  try {
    const base = "http://127.0.0.1:" + server.address().port;
    for (const path of ["/health", "/auth/session", "/socket.io/?transport=polling"]) {
      const response = await fetch(base + path);
      assert.equal(response.status, path === "/health" ? 200 : 503);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("retry-after"), "30");
      const state = await response.json();
      assert.equal(state.ok, false);
      assert.equal(state.maintenance, true);
      assert.equal(state.code, "SERVER_MAINTENANCE");
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
