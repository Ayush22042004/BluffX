// One indexed heap, one timer, bounded concurrent room work. No idle room scans.
class DeadlineScheduler {
  constructor(run, { now = Date.now, concurrency = 4 } = {}) {
    this.run = run;
    this.now = now;
    this.concurrency = concurrency;
    this.heap = [];
    this.positions = new Map();
    this.running = new Set();
    this.after = new Map();
    this.timer = null;
    this.closed = false;
    this.wakeups = 0;
  }
  swap(a, b) {
    [this.heap[a], this.heap[b]] = [this.heap[b], this.heap[a]];
    this.positions.set(this.heap[a].id, a);
    this.positions.set(this.heap[b].id, b);
  }
  repair(i) {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.heap[p].at <= this.heap[i].at) break;
      this.swap(i, p);
      i = p;
    }
    for (;;) {
      let m = i,
        l = i * 2 + 1,
        r = l + 1;
      if (l < this.heap.length && this.heap[l].at < this.heap[m].at) m = l;
      if (r < this.heap.length && this.heap[r].at < this.heap[m].at) m = r;
      if (m === i) break;
      this.swap(i, m);
      i = m;
    }
  }
  remove(id) {
    const i = this.positions.get(id);
    if (i === undefined) return;
    const last = this.heap.pop();
    this.positions.delete(id);
    if (i < this.heap.length) {
      this.heap[i] = last;
      this.positions.set(last.id, i);
      this.repair(i);
    }
  }
  set(id, at) {
    if (this.closed) return;
    if (this.running.has(id)) {
      this.after.set(id, at);
      return;
    }
    this.remove(id);
    if (Number.isFinite(at)) {
      this.positions.set(id, this.heap.length);
      this.heap.push({ id, at });
      this.repair(this.heap.length - 1);
    }
    this.arm();
  }
  arm() {
    if (
      this.timer &&
      !this.closed &&
      this.running.size < this.concurrency &&
      this.heap[0]?.at === this.armedAt
    )
      return;
    clearTimeout(this.timer);
    this.timer = null;
    if (
      this.closed ||
      !this.heap.length ||
      this.running.size >= this.concurrency
    )
      return;
    this.timer = setTimeout(
      () => this.flush(),
      Math.max(0, Math.min(2147483647, this.heap[0].at - this.now())),
    );
    this.armedAt = this.heap[0].at;
    this.timer.unref?.();
  }
  flush() {
    this.timer = null;
    if (this.closed) return;
    this.wakeups++;
    while (
      this.heap.length &&
      this.heap[0].at <= this.now() &&
      this.running.size < this.concurrency
    ) {
      const { id } = this.heap[0];
      this.remove(id);
      this.running.add(id);
      Promise.resolve()
        .then(() => this.run(id))
        .catch(() => {})
        .finally(() => {
          this.running.delete(id);
          if (this.after.has(id)) {
            const at = this.after.get(id);
            this.after.delete(id);
            this.set(id, at);
          }
          this.arm();
        });
    }
    this.arm();
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = null;
    this.heap.length = 0;
    this.positions.clear();
    this.after.clear();
  }
}
module.exports = { DeadlineScheduler };
