process.env.GAME_PING_INTERVAL_MS = "5000";
process.env.GAME_PING_TIMEOUT_MS = "20000";
require("./postgres-fixture.cjs");
const test = require("node:test"), assert = require("node:assert/strict");
const { startServer } = require("../src/index");
const { io } = require("./socket-client.cjs");
const { loadRules } = require("../src/rules");
test("heartbeat defaults tolerate mobile latency without increasing ping frequency", () => {
  const rules = loadRules({});
  assert.equal(rules.socketPingIntervalMs, 25000); assert.equal(rules.socketPingTimeoutMs, 20000);
  for (const env of [{ GAME_PING_INTERVAL_MS: "1000" }, { GAME_PING_TIMEOUT_MS: "0" }]) assert.throws(() => loadRules(env));
});
test("a real socket survives a pong delayed longer than the old four-second timeout", { timeout: 20000 }, async () => {
  const app = await startServer({ port: 0 });
  const socket = io("http://localhost:" + app.server.address().port, { autoConnect: false, transports: ["websocket"], reconnection: false });
  const timers = [];
  try {
    await new Promise((resolve, reject) => { socket.once("server_ready", resolve); socket.once("connect_error", reject); socket.connect(); });
    const transport = socket.io.engine.transport, original = transport.send.bind(transport);
    let delayed = false;
    await new Promise((resolve, reject) => {
      timers.push(setTimeout(() => reject(Error("Delayed heartbeat test timed out")), 14000));
      transport.send = packets => {
        if (!delayed && packets.some(p => p.type === "pong")) {
          delayed = true;
          timers.push(setTimeout(() => { original(packets); resolve(); }, 5500));
        } else original(packets);
      };
    });
    assert.equal(socket.connected, true);
    const response = await new Promise((resolve, reject) => socket.timeout(2000).emit("heartbeat_probe", {}, (err, ack) => err ? reject(err) : resolve(ack)));
    assert.equal(response.code, "UNKNOWN_ACTION");
  } finally { timers.forEach(clearTimeout); socket.disconnect(); await app.close(); }
});
