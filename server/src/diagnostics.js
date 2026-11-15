const { performance, monitorEventLoopDelay } = require("node:perf_hooks");
class Diagnostics {
  constructor(enabled = false) {
    this.enabled = enabled;
    this.counts = Object.create(null);
    this.samples = new Map();
    this.lag = enabled ? monitorEventLoopDelay({ resolution: 20 }) : null;
    this.lag?.enable();
  }
  add(name, n = 1) {
    if (this.enabled) this.counts[name] = (this.counts[name] || 0) + n;
  }
  observe(name, ms) {
    if (!this.enabled) return;
    let h = this.samples.get(name);
    if (!h) {
      h = { count: 0, sum: 0, values: [] };
      this.samples.set(name, h);
    }
    h.values[h.count % 256] = ms;
    h.count++;
    h.sum += ms;
  }
  start() {
    return this.enabled ? performance.now() : 0;
  }
  end(name, start) {
    if (this.enabled) this.observe(name, performance.now() - start);
  }
  report(extra = {}) {
    const latency = {};
    for (const [key, h] of this.samples) {
      const sorted = [...h.values].sort((a, b) => a - b);
      latency[key] = {
        count: h.count,
        averageMs: h.sum / h.count,
        p95Ms: sorted[Math.floor((sorted.length - 1) * 0.95)],
      };
    }
    return {
      enabled: this.enabled,
      ...extra,
      counters: { ...this.counts },
      latency,
      eventLoopP95Ms: this.lag ? this.lag.percentile(95) / 1e6 : null,
      memory: process.memoryUsage(),
      cpu: process.cpuUsage(),
      perCompletedRound: this.counts.rounds
        ? {
            sqlCalls: (this.counts.sqlCalls || 0) / this.counts.rounds,
            messages: (this.counts.messages || 0) / this.counts.rounds,
          }
        : null,
    };
  }
  close() {
    this.lag?.disable();
  }
}
module.exports = { Diagnostics };
