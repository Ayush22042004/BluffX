// Page restoration is not a new login. Only the auth owner enables a connection;
// lifecycle events may restore it, but must never undo logout or queue a move.
export function createConnectionLifecycle(socket, { window: win, document: doc, navigator: nav, record = () => {} }) {
  let enabled = false;
  const resume = () => {
    if (enabled && nav.onLine !== false && doc.visibilityState !== "hidden" && !socket.connected && !socket.active) socket.connect();
  };
  const offline = () => { record("NETWORK_OFFLINE"); if (enabled) socket.disconnect(); };
  const hidden = () => { record("PAGE_HIDDEN"); if (enabled) socket.disconnect(); };
  const shown = () => { record("PAGE_RESUMED"); resume(); };
  const visible = () => { if (doc.visibilityState === "visible") shown(); };
  win.addEventListener("offline", offline);
  win.addEventListener("online", resume);
  win.addEventListener("pagehide", hidden);
  win.addEventListener("pageshow", shown);
  doc.addEventListener("visibilitychange", visible);
  return {
    get enabled() { return enabled; },
    setEnabled(value) { enabled = !!value; if (enabled) resume(); else socket.disconnect(); },
    close() {
      enabled = false;
      win.removeEventListener("offline", offline); win.removeEventListener("online", resume);
      win.removeEventListener("pagehide", hidden); win.removeEventListener("pageshow", shown);
      doc.removeEventListener("visibilitychange", visible);
    },
  };
}
