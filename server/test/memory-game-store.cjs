// Explicit test double; never imported by production startup.
const {
  snapshot,
  checksum,
  error,
  finalResults,
} = require("../src/game-store");
class MemoryGameStore {
  constructor() {
    this.states = new Map();
    this.receipts = new Map();
    this.results = new Map();
    this.available = true;
    this.commitCount = 0;
    this.fail = false;
  }
  async load() {
    return [...this.states.values()].filter((r) => !r.closed).map(snapshot);
  }
  async loadRoom(code) {
    return this.states.has(code) ? snapshot(this.states.get(code)) : null;
  }
  async receipt(code, id, action) {
    return this.receipts.get(`${code}:${id}:${action}`);
  }
  async receiptAnywhere(id, action) {
    for (const [key, value] of this.receipts)
      if (key.endsWith(`:${id}:${action}`)) return value;
    return null;
  }
  async commit(room, expected, receipt) {
    if (this.fail) throw error("TEST_OUTAGE", "Database unavailable");
    if ((this.states.get(room.id)?.version || 0) !== expected)
      throw error("VERSION_CONFLICT", "Conflict");
    if (
      receipt &&
      this.receipts.has(`${room.id}:${receipt.seatId}:${receipt.actionId}`)
    )
      throw Object.assign(Error("duplicate receipt"), { code: "23505" });
    this.commitCount++;
    this.states.set(room.id, snapshot(room));
    if (receipt)
      this.receipts.set(`${room.id}:${receipt.seatId}:${receipt.actionId}`, {
        fingerprint: receipt.fingerprint,
        acknowledgement: snapshot(receipt.ack),
      });
    if (
      (room.phase === "finished" || room.closed) &&
      room.matchId &&
      !this.results.has(room.matchId)
    )
      this.results.set(room.matchId, finalResults(room));
    return receipt?.ack;
  }
  async stats(user) {
    const rows = [...this.results.values()]
      .flat()
      .filter((r) => r.userId === user);
    const games = rows.filter((r) => r.ranked).length,
      wins = rows.filter((r) => r.ranked && r.won).length;
    return {
      games,
      wins,
      losses: games - wins,
      calls: rows.reduce((n, r) => n + r.calls, 0),
      correct: rows.reduce((n, r) => n + r.correct, 0),
      winRate: games ? Math.round((wins / games) * 100) : 0,
      unrankedGames: rows.filter((r) => !r.ranked).length,
    };
  }
  async leaderboard(page = 0, limit = 20) {
    const users = new Map();
    for (const r of this.states.values())
      for (const p of r.participants || [])
        if (p.accountId) users.set(p.accountId, p);
    const entries = [];
    for (const [id, p] of users) {
      const stats = await this.stats(id);
      if (stats.games)
        entries.push({
          id,
          name: p.name,
          avatar: p.avatar,
          avatarId: p.avatarId || null,
          ...stats,
        });
    }
    entries.sort(
      (a, b) =>
        b.wins - a.wins || b.winRate - a.winRate || a.id.localeCompare(b.id),
    );
    for (let n = 0; n < entries.length; n++)
      entries[n].rank =
        n &&
        entries[n].wins === entries[n - 1].wins &&
        entries[n].winRate === entries[n - 1].winRate
          ? entries[n - 1].rank
          : n + 1;
    return {
      page,
      limit,
      total: entries.length,
      players: entries.slice(page * limit, (page + 1) * limit),
    };
  }
  async prune() {}
  async close() {
    this.available = false;
  }
}
module.exports = { MemoryGameStore };
