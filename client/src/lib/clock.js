let anchor = { server: Date.now(), local: performance.now() },
  timer;
const listeners = new Set();
export const serverTime = () =>
  anchor.server + performance.now() - anchor.local;
export function synchronizeClock(serverNow) {
  if (!Number.isFinite(serverNow)) return;
  anchor = { server: serverNow, local: performance.now() };
  for (const listener of listeners) listener();
}
export function subscribeClock(listener) {
  listeners.add(listener);
  if (!timer)
    timer = setInterval(() => {
      for (const fn of listeners) fn();
    }, 250);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      clearInterval(timer);
      timer = null;
    }
  };
}
