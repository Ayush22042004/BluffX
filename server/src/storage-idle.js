// One managed idle deadline. Health checks and socket heartbeats never enter it.
class StorageIdle {
  constructor({ store, canSleep, wake, idleMs, onError = () => {} }) {
    Object.assign(this, { store, canSleep, wake, idleMs, onError });
    this.active = 0;
    this.timer = null;
    this.parking = null;
    this.waking = null;
    this.closed = false;
    this.lastWakeError = false;
  }
  async enter() {
    if (this.closed) throw Object.assign(Error("Storage is closing."), { code: "STORAGE_UNAVAILABLE" });
    this.active++;
    clearTimeout(this.timer);
    this.timer = null;
    try {
      await this.parking;
      if (!this.waking && this.store.parked)
        this.waking = Promise.resolve().then(this.wake).finally(() => { this.waking = null; });
      // Ownership may be reacquired before room/seat restoration has finished.
      // Every concurrent entrant must wait for the entire recovery, not just SQL.
      await this.waking;
      if (!this.store.available)
        throw Object.assign(Error("Storage is recovering."), { code: "STORAGE_UNAVAILABLE" });
      this.lastWakeError = false;
    } catch (e) {
      this.lastWakeError = true;
      this.active--;
      this.touch();
      throw Object.assign(new Error("Game storage is temporarily unavailable. Please retry shortly.", { cause: e }), { code: "STORAGE_UNAVAILABLE", status: 503 });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.touch();
    };
  }
  async run(work) {
    const release = await this.enter();
    try { return await work(); } finally { release(); }
  }
  touch() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.closed || this.active || this.parking || this.waking || this.store.parked || !this.store.available || !this.canSleep()) return;
    this.timer = setTimeout(() => this.sleep(), this.idleMs);
    this.timer.unref?.();
  }
  async sleep() {
    this.timer = null;
    if (this.closed || this.active || this.parking || this.waking || !this.canSleep()) return;
    this.parking = this.store.park();
    try { await this.parking; } catch (e) { this.onError(e); }
    finally { this.parking = null; }
  }
  async close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = null;
    await Promise.allSettled([this.parking, this.waking]);
  }
}

// Retention work runs only after meaningful database activity, never on a timer.
class DemandMaintenance {
  constructor(work, { intervalMs, now = Date.now, onError = () => {} }) {
    Object.assign(this, { work, intervalMs, now, onError });
    this.nextAt = now() + intervalMs;
    this.running = null;
    this.closed = false;
  }
  notify() {
    if (this.closed || this.running || this.now() < this.nextAt) return;
    this.nextAt = this.now() + this.intervalMs;
    this.running = Promise.resolve().then(this.work).catch(this.onError).finally(() => { this.running = null; });
  }
  async close() { this.closed = true; await this.running; }
}
module.exports = { StorageIdle, DemandMaintenance };
