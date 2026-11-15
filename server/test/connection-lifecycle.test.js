const test = require("node:test"), assert = require("node:assert/strict");
function setup(createConnectionLifecycle) {
  const win = new EventTarget(), doc = new EventTarget(), nav = { onLine: true };
  doc.visibilityState = "visible";
  const socket = { connected: false, active: false, connects: 0, disconnects: 0,
    connect() { this.connects++; this.active = true; }, disconnect() { this.disconnects++; this.active = false; this.connected = false; } };
  return { win, doc, nav, socket, lifecycle: createConnectionLifecycle(socket, { window: win, document: doc, navigator: nav }) };
}
test("phone pageshow resumes an enabled connection even when persisted is false", async () => {
  const { createConnectionLifecycle } = await import("../../client/src/lib/connection-lifecycle.js");
  const { win, socket, lifecycle } = setup(createConnectionLifecycle);
  lifecycle.setEnabled(true); socket.connected = true;
  win.dispatchEvent(new Event("pagehide"));
  assert.equal(socket.connected, false);
  const shown = new Event("pageshow"); shown.persisted = false; win.dispatchEvent(shown);
  assert.equal(socket.connects, 2);
  win.dispatchEvent(shown); assert.equal(socket.connects, 2);
  lifecycle.close();
});
test("lifecycle recovery respects logout, offline state and existing reconnect attempts", async () => {
  const { createConnectionLifecycle } = await import("../../client/src/lib/connection-lifecycle.js");
  const { win, doc, nav, socket, lifecycle } = setup(createConnectionLifecycle);
  lifecycle.setEnabled(true); socket.connected = true;
  nav.onLine = false; win.dispatchEvent(new Event("offline"));
  win.dispatchEvent(new Event("pageshow")); assert.equal(socket.connects, 1);
  lifecycle.setEnabled(false); nav.onLine = true;
  win.dispatchEvent(new Event("online")); win.dispatchEvent(new Event("pageshow"));
  doc.dispatchEvent(new Event("visibilitychange")); assert.equal(socket.connects, 1);
  lifecycle.setEnabled(true); assert.equal(socket.connects, 2);
  doc.dispatchEvent(new Event("visibilitychange")); assert.equal(socket.connects, 2);
  socket.active = false; socket.connected = false; doc.visibilityState = "hidden";
  win.dispatchEvent(new Event("online")); assert.equal(socket.connects, 2);
  doc.visibilityState = "visible"; doc.dispatchEvent(new Event("visibilitychange"));
  assert.equal(socket.connects, 3);
  lifecycle.close(); socket.active = false; win.dispatchEvent(new Event("online"));
  assert.equal(socket.connects, 3);
});
test("connection diagnostics contain at most ten predefined reason codes", async () => {
  const { recordConnection, connectionDiagnostics } = await import("../../client/src/lib/connection-diagnostics.js");
  for (let i = 0; i < 20; i++) { recordConnection("SOCKET_CONNECTED"); recordConnection("SOCKET_PING_TIMEOUT"); }
  recordConnection("SECRET_PRIVATE_DATA");
  const result = connectionDiagnostics();
  assert.equal(result.length, 10); assert.ok(result.every(v => ["SOCKET_CONNECTED", "SOCKET_PING_TIMEOUT"].includes(v)));
  result.push("FORGED"); assert.equal(connectionDiagnostics().length, 10);
});
