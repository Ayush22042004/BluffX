const test = require("node:test");
const assert = require("node:assert/strict");
const { StorageIdle, DemandMaintenance } = require("../src/storage-idle");
const flush = () => new Promise(setImmediate);
test("idle storage releases ownership once and never polls or wakes on its own", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let parks = 0, wakes = 0, eligible = true;
  const store = { available: true, parked: false, async park() { parks++; this.parked = true; } };
  const idle = new StorageIdle({ store, idleMs: 1000, canSleep: () => eligible, wake: async () => { wakes++; store.parked = false; } });
  idle.touch(); t.mock.timers.tick(1001); await flush();
  assert.equal(parks, 1); assert.equal(store.parked, true);
  t.mock.timers.tick(86400000); await flush();
  assert.equal(wakes, 0); assert.equal(parks, 1);
  await idle.run(async () => assert.equal(store.parked, false));
  assert.equal(wakes, 1);
  eligible = false; idle.touch(); t.mock.timers.tick(86400000); await flush();
  assert.equal(parks, 1);
  await idle.close();
});
test("concurrent cold requests wait for full seat restoration after ownership is acquired", async () => {
  let resume, started;
  const barrier = new Promise(r => { resume = r; });
  const begun = new Promise(r => { started = r; });
  const store = { available: true, parked: true };
  let wakes = 0, operations = 0;
  const idle = new StorageIdle({ store, idleMs: 1000, canSleep: () => false, wake: async () => {
    wakes++; store.parked = false; started(); await barrier;
  } });
  const first = idle.run(async () => { operations++; });
  await begun;
  const second = idle.run(async () => { operations++; });
  await flush(); assert.equal(operations, 0);
  resume(); await Promise.all([first, second]);
  assert.equal(wakes, 1); assert.equal(operations, 2); assert.equal(idle.active, 0);
  await idle.close();
});
test("in-flight work prevents parking; a failed cold start never executes the action or retries on a timer", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let parks = 0, wakes = 0;
  const store = { available: true, parked: false, async park() { parks++; this.parked = true; } };
  const idle = new StorageIdle({ store, idleMs: 1000, canSleep: () => true, wake: async () => { wakes++; throw Error("cold connection failed"); } });
  const release = await idle.enter(); idle.touch(); t.mock.timers.tick(5000); await flush(); assert.equal(parks, 0);
  release(); release(); assert.equal(idle.active, 0);
  t.mock.timers.tick(1001); await flush(); assert.equal(parks, 1);
  await assert.rejects(idle.run(() => assert.fail("Action executed before storage recovery")), /temporarily unavailable/);
  t.mock.timers.tick(86400000); await flush(); assert.equal(wakes, 1);
  await idle.close();
});
test("retention runs once on demand after its interval, with no idle timer or recursive cleanup", async () => {
  let now = 0, runs = 0;
  const maintenance = new DemandMaintenance(async () => { runs++; maintenance.notify(); }, { intervalMs: 3600000, now: () => now });
  now = 86400000; await flush(); assert.equal(runs, 0);
  maintenance.notify(); maintenance.notify(); await flush(); assert.equal(runs, 1);
  maintenance.notify(); await flush(); assert.equal(runs, 1);
  now += 3600000; maintenance.notify(); await flush(); assert.equal(runs, 2);
  await maintenance.close(); now += 3600000; maintenance.notify(); await flush(); assert.equal(runs, 2);
});
