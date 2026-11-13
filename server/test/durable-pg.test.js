const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  createGameStore,
  GameStore,
  snapshot,
  checksum,
} = require("../src/game-store");
const { RoomService } = require("../src/room-service");
const { envelope } = require("../src/protocol");
const { Pool } = require("pg");
const { verifiedConnectionString } = require("../src/database");
const URL = process.env.TEST_DATABASE_URL;
test(
  "real PostgreSQL: atomic snapshots, receipts, fencing, restarts, result finalization and statistics",
  { skip: !URL, timeout: 300000 },
  async (t) => {
    let store = await createGameStore({
      connectionString: URL,
      directUrl: URL,
      autoMigrate: true,
    });
    let now = Date.now();
    let service = new RoomService(store, { now: () => now, random: () => 0.1 });
    await service.initialize();
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    for (let n = 0; n < 2; n++)
      await store.pool.query(
        "INSERT INTO users(id,email,name,avatar,created_at) VALUES($1,$2,$3,0,$4)",
        [ids[n], `reliability-${ids[n]}@example.com`, `Reliability ${n}`, now],
      );
    const a = {
        id: crypto.randomUUID(),
        accountId: ids[0],
        profile: { emailVerified: true, name: "A", avatar: 0 },
        generation: 1,
        proposal: crypto.randomBytes(32).toString("hex"),
      },
      b = {
        id: crypto.randomUUID(),
        accountId: ids[1],
        profile: { emailVerified: true, name: "B", avatar: 1 },
        generation: 1,
        proposal: crypto.randomBytes(32).toString("hex"),
      };
    let code;
    const room = () => service.rooms.get(code);
    const send = (who, event, data = {}) =>
      service.command(code, who, event, {
        ...envelope(room()),
        ...data,
        actionId: data.actionId || crypto.randomUUID(),
      });
    const seed = async (fn) => {
      const old = room(),
        next = snapshot(old);
      fn(next);
      await service.save(old, next, null);
    };
    async function restart(restore = true) {
      await store.close();
      store = await createGameStore({ connectionString: URL, directUrl: URL });
      service = new RoomService(store, { now: () => now, random: () => 0.1 });
      await service.initialize();
      if (restore)
        for (const p of [a, b]) {
          const proposal = crypto.randomBytes(32).toString("hex");
          const resumed = await service.resume({ ...p, proposal }, [
            p.proposal,
          ]);
          if (resumed) {
            p.proposal = proposal;
            p.generation = resumed.generation;
          }
        }
    }
    try {
      const created = await service.create(a, {
        name: "A",
        maxPlayers: 2,
        turnSeconds: 20,
        actionId: crypto.randomUUID(),
      });
      code = created.roomId;
      await service.join(code, b, { name: "B", actionId: crypto.randomUUID() });
      await send(b, "set_ready", { ready: true });
      await send(a, "start_game");
      await t.test(
        "SQL timeouts are configured and interrupted transactions leave the pool usable",
        async () => {
          await assert.rejects(
            store.transaction(async (client) => {
              const configured = (await client.query("SHOW statement_timeout"))
                .rows[0].statement_timeout;
              assert.ok(["10s", "10000ms"].includes(configured));
              await client.query("SET LOCAL statement_timeout='50ms'");
              await client.query("SELECT pg_sleep(0.2)");
            }),
            { code: "57014" },
          );
          assert.equal(
            (await store.pool.query("SELECT 1 AS ok")).rows[0].ok,
            1,
          );
        },
      );
      await t.test("only one process may own the database", async () => {
        await assert.rejects(
          createGameStore({ connectionString: URL, directUrl: URL }),
          { code: "SERVER_ALREADY_RUNNING" },
        );
      });
      await t.test(
        "restart during a human turn restores cards, sequences, scores and exact deadline",
        async () => {
          const before = snapshot(room());
          now += 250;
          await restart();
          assert.deepEqual(room().hands, before.hands);
          assert.equal(room().turnEndsAt, before.turnEndsAt);
          assert.equal(room().turnSequence, before.turnSequence);
          assert.deepEqual(room().matchScores, before.matchScores);
        },
      );
      let committed;
      await t.test(
        "concurrent duplicate play requests produce one receipt and one durable version",
        async () => {
          const r = room();
          committed = {
            ...envelope(r),
            actionId: crypto.randomUUID(),
            cardIds: [r.hands[a.id][0].id],
            declaredRank: r.hands[a.id][0].rank,
          };
          const version = r.version;
          const replies = await Promise.all([
            service.command(code, a, "play_cards", committed),
            service.command(code, a, "play_cards", committed),
          ]);
          assert.equal(room().version, version + 1);
          assert.equal(replies[1].duplicate, true);
          assert.equal(
            Number(
              (
                await store.pool.query(
                  "SELECT COUNT(*) AS n FROM bx_actions WHERE action_id=$1",
                  [committed.actionId],
                )
              ).rows[0].n,
            ),
            1,
          );
        },
      );
      await t.test(
        "a successful action whose response was lost is idempotent after recovery",
        async () => {
          const cards = snapshot(room().hands);
          await restart();
          const ack = await service.command(code, a, "play_cards", committed);
          assert.equal(ack.duplicate, true);
          assert.deepEqual(room().hands, cards);
        },
      );
      await t.test(
        "simultaneous challenges commit exactly one reveal and penalty; restart preserves it",
        async () => {
          const data = {
            ...envelope(room()),
            selectedIndexes: [0],
            actionId: crypto.randomUUID(),
          };
          const old = snapshot(room());
          const results = await Promise.allSettled([
            service.command(code, b, "call_bluff", data),
            service.command(code, b, "call_bluff", {
              ...data,
              actionId: crypto.randomUUID(),
            }),
          ]);
          assert.equal(
            results.filter((r) => r.status === "fulfilled").length,
            1,
          );
          assert.equal(room().phase, "round_result");
          const hands = snapshot(room().hands),
            deadline = room().resultDeadline;
          await restart();
          assert.deepEqual(room().hands, hands);
          assert.equal(room().resultDeadline, deadline);
        },
      );
      await t.test(
        "automatic result advancement races a host action without redealing or restarting countdown",
        async () => {
          const old = envelope(room());
          now = room().resultDeadline;
          const results = await Promise.allSettled([
            service.tick(),
            service.command(code, a, "continue_round", {
              ...old,
              actionId: crypto.randomUUID(),
            }),
          ]);
          assert.equal(room().roundNumber, 2);
          const round = room().roundId;
          await service.tick();
          assert.equal(room().roundId, round);
        },
      );
      await t.test(
        "database error after snapshot update rolls back cards and acknowledgement together",
        async () => {
          const before = snapshot(room()),
            next = snapshot(before);
          next.version++;
          next.currentTurnIndex = 1 - next.currentTurnIndex;
          const existing = (
            await store.pool.query(
              "SELECT * FROM bx_actions WHERE room_code=$1 LIMIT 1",
              [code],
            )
          ).rows[0];
          await assert.rejects(
            store.commit(next, before.version, {
              seatId: existing.player_id,
              actionId: existing.action_id,
              fingerprint: "collision",
              ack: { ok: true },
            }),
          );
          const persisted = await store.loadRoom(code);
          assert.deepEqual(persisted, before);
          assert.equal(checksum(persisted), checksum(before));
        },
      );
      await t.test(
        "a dropped PostgreSQL connection during a card play cannot acknowledge or publish the move",
        async () => {
          const before = snapshot(room()),
            current = room().players[room().currentTurnIndex],
            who = current.id === a.id ? a : b;
          const transaction = store.transaction.bind(store),
            broadcasts = [];
          const priorCommit = service.onCommit;
          service.onCommit = (r) => broadcasts.push(r.version);
          store.transaction = (work) =>
            transaction(async (client) => {
              const result = await work(client);
              await client.end();
              return result;
            });
          try {
            await assert.rejects(
              send(who, "play_cards", {
                cardIds: [room().hands[who.id][0].id],
                declaredRank: "J",
              }),
            );
          } finally {
            store.transaction = transaction;
            service.onCommit = priorCommit;
          }
          assert.deepEqual(room(), before);
          assert.equal(broadcasts.length, 0);
          assert.deepEqual(await store.loadRoom(code), before);
          await service.synchronizeStorage(code);
        },
      );
      await t.test(
        "optimistic versions and fencing reject stale writers",
        async () => {
          const before = snapshot(room()),
            next = snapshot(before);
          next.version++;
          await assert.rejects(store.commit(next, before.version - 1), {
            code: "VERSION_CONFLICT",
          });
          const stale = new GameStore(store.pool, null, store.epoch - 1);
          await assert.rejects(stale.commit(next, before.version), {
            code: "SERVER_FENCED",
          });
          assert.deepEqual(await store.loadRoom(code), before);
        },
      );
      await t.test(
        "AI takeover budget, grace consumption and AFK strikes survive restart",
        async () => {
          await service.disconnect(code, b);
          now += 1000;
          const proposed = crypto.randomBytes(32).toString("hex"),
            resumed = await service.resume({ ...b, proposal: proposed }, [
              b.proposal,
            ]);
          b.proposal = proposed;
          b.generation = resumed.generation;
          await seed((r) => {
            const p = r.players.find((p) => p.id === b.id);
            p.aiRoundsUsed = 2;
            p.afkStrikes = 2;
            p.aiTakeover = true;
            p.aiUsed = true;
            p.connected = false;
            p.controlReason = "offline";
            p.takeoverAt = now;
            p.takeoverRound = r.completedRounds;
          });
          const budget = room().players.find(
            (p) => p.id === b.id,
          ).graceRemainingMs;
          await restart(false);
          const p = room().players.find((p) => p.id === b.id);
          assert.equal(p.aiRoundsUsed, 2);
          assert.equal(p.afkStrikes, 2);
          assert.equal(p.graceRemainingMs, budget);
          assert.equal(p.aiTakeover, true);
          assert.equal(p.connected, false);
          await restart();
        },
      );
      await t.test(
        "finalization is atomic and duplicate attempts update official statistics only once",
        async () => {
          const data = { ...envelope(room()), actionId: crypto.randomUUID() };
          const replies = await Promise.all([
            service.command(code, b, "leave_room", data),
            service.command(code, b, "leave_room", data),
          ]);
          assert.equal(room().winnerId, a.id);
          assert.equal(replies[1].duplicate, true);
          assert.equal(
            Number(
              (
                await store.pool.query(
                  "SELECT COUNT(*) AS n FROM bx_results WHERE match_id=$1",
                  [room().matchId],
                )
              ).rows[0].n,
            ),
            2,
          );
          const stats = await store.stats(ids[0]);
          assert.equal(stats.games, 1);
          assert.equal(stats.wins, 1);
          assert.equal((await store.stats(ids[1])).losses, 1);
          const old = snapshot(room()),
            next = snapshot(old);
          next.version++;
          await store.commit(next, old.version);
          service.rooms.set(code, next);
          assert.equal((await store.stats(ids[0])).wins, 1);
          const ranking = await store.leaderboard(0, 20);
          assert.ok(
            ranking.players.some((p) => p.id === ids[0] && p.wins === 1),
          );
        },
      );
      await t.test(
        "leaderboard ties share ranks and pagination has stable distinct entries",
        async () => {
          const tieIds = [crypto.randomUUID(), crypto.randomUUID()];
          for (const id of tieIds) {
            ids.push(id);
            await store.pool.query(
              "INSERT INTO users(id,email,name,avatar,created_at) VALUES($1,$2,'Tie fixture',0,$3)",
              [id, `tie-${id}@example.com`, now],
            );
            await store.pool.query(
              "INSERT INTO bx_player_stats(user_id,games,wins,losses,updated_at) VALUES($1,1,1,0,$2)",
              [id, now],
            );
          }
          const board = await store.leaderboard(0, 50);
          const tied = board.players.filter((p) =>
            [ids[0], ...tieIds].includes(p.id),
          );
          assert.equal(tied.length, 3);
          assert.equal(new Set(tied.map((p) => p.rank)).size, 1);
          const one = await store.leaderboard(0, 1),
            two = await store.leaderboard(1, 1);
          assert.notEqual(one.players[0].id, two.players[0].id);
          assert.equal(one.total, two.total);
          assert.equal(one.total, board.total);
        },
      );
      await t.test(
        "completed results and totals survive a final server restart",
        async () => {
          const match = room().matchId;
          await restart();
          assert.equal((await store.stats(ids[0])).wins, 1);
          assert.equal(
            (
              await store.pool.query(
                "SELECT finalized FROM bx_matches WHERE match_id=$1",
                [match],
              )
            ).rows[0].finalized,
            true,
          );
        },
      );
    } finally {
      // Only this test's own users and active room are retired; no global reset.
      if (code && service.rooms.has(code)) {
        const old = room(),
          r = snapshot(old);
        r.closed = true;
        r.version++;
        await store.commit(r, old.version).catch(() => {});
      }
      for (const id of ids)
        await store.pool.query("DELETE FROM users WHERE id=$1", [id]);
      await store.close();
    }
  },
);
