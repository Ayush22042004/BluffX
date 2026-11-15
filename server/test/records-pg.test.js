const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto"), fs = require("node:fs");
const { createGameStore, snapshot } = require("../src/game-store");
const { RoomService } = require("../src/room-service");
const { envelope } = require("../src/protocol");
const { RULES } = require("../src/rules");
const URL = process.env.TEST_DATABASE_URL;
test("real PostgreSQL: casual victories persist, recover after restart and cannot inflate ranked standings", { skip: !URL, timeout: 180000 }, async t => {
  let store = await createGameStore({ connectionString: URL, directUrl: URL, autoMigrate: true });
  let service = new RoomService(store, { rules: { ...RULES, playtestUnranked: true } });
  const users = [crypto.randomUUID(), crypto.randomUUID()];
  const actors = users.map(accountId => ({ id: crypto.randomUUID(), accountId, profile: { name: "Casual Tester", emailVerified: true }, generation: 1, proposal: crypto.randomBytes(32).toString("hex") }));
  let code;
  try {
    await service.initialize();
    for (const id of users) await store.pool.query("INSERT INTO users(id,email,name,email_verified,created_at) VALUES($1,$2,'Casual Tester',1,$3)", [id, id + "@example.com", Date.now()]);
    code = (await service.create(actors[0], { name: "Casual Winner", maxPlayers: 2, actionId: crypto.randomUUID() })).roomId;
    await service.join(code, actors[1], { name: "Casual Peer", actionId: crypto.randomUUID() });
    const send = (who, event, data = {}) => service.command(code, who, event, { ...envelope(service.rooms.get(code)), actionId: crypto.randomUUID(), ...data });
    await send(actors[1], "set_ready", { ready: true }); await send(actors[0], "start_game");
    const leave = { ...envelope(service.rooms.get(code)), actionId: crypto.randomUUID() };
    await Promise.all([send(actors[1], "leave_room", leave), send(actors[1], "leave_room", leave)]);
    const stats = await store.stats(users[0]);
    assert.equal(stats.totalGames, 1); assert.equal(stats.totalWins, 1); assert.equal(stats.totalWinRate, 100);
    assert.equal(stats.games, 0); assert.equal(stats.wins, 0); assert.equal(stats.unrankedWins, 1);
    assert.equal((await store.stats(users[1])).totalLosses, 1);
    assert.ok(!(await store.leaderboard(0, 100)).players.some(p => p.id === users[0]));
    const old = service.rooms.get(code), next = snapshot(old); next.version++;
    await store.commit(next, old.version);
    assert.equal((await store.stats(users[0])).totalWins, 1);
    await store.close(); store = await createGameStore({ connectionString: URL, directUrl: URL });
    service = new RoomService(store); await service.initialize();
    assert.equal((await store.stats(users[0])).totalWins, 1);
    // Totals remain durable even if detailed history is subsequently retired.
    await store.pool.query("DELETE FROM bx_results WHERE match_id=$1", [next.matchId]);
    assert.equal((await store.stats(users[0])).totalWins, 1);
    await t.test("migration backfills existing casual results once without changing ranked counters", async () => {
      const c = await store.pool.connect();
      try {
        await c.query("BEGIN");
        const schema = "record_test_" + crypto.randomBytes(8).toString("hex");
        await c.query("CREATE SCHEMA " + schema); await c.query("SET LOCAL search_path TO " + schema);
        await c.query("CREATE TABLE bx_player_stats(user_id TEXT PRIMARY KEY,games BIGINT,wins BIGINT,unranked_games BIGINT); CREATE TABLE bx_results(user_id TEXT,ranked BOOLEAN,won BOOLEAN)");
        await c.query("INSERT INTO bx_player_stats VALUES('a',1,1,3); INSERT INTO bx_results VALUES('a',TRUE,TRUE),('a',FALSE,TRUE),('a',FALSE,TRUE),('a',FALSE,FALSE)");
        const migration = fs.readFileSync(require("node:path").join(__dirname, "../migrations/008_personal_record_totals.sql"), "utf8");
        await c.query(migration); await c.query(migration);
        const result = (await c.query("SELECT * FROM bx_player_stats")).rows[0];
        assert.equal(Number(result.unranked_wins), 2); assert.equal(Number(result.wins), 1); assert.equal(Number(result.games), 1);
      } finally { await c.query("ROLLBACK"); c.release(); }
    });
  } finally {
    if (code && service.rooms.has(code)) {
      const old = service.rooms.get(code), next = snapshot(old); next.closed = true; next.version++;
      await store.commit(next, old.version).catch(() => {});
    }
    for (const id of users) await store.pool.query("DELETE FROM users WHERE id=$1", [id]);
    await store.close();
  }
});
