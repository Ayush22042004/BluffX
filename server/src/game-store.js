const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Pool, Client } = require("pg");
const { verifiedConnectionString } = require("./database");
const { RULES } = require("./rules");
const migrationDir = path.join(__dirname, "../migrations");
const migrationFiles = () =>
  fs
    .readdirSync(migrationDir)
    .filter((name) => /^\d+_.*\.sql$/.test(name))
    .sort()
    .map((name) => ({
      name: name.replace(/\.sql$/, ""),
      sql: fs.readFileSync(path.join(migrationDir, name), "utf8"),
    }));
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const error = (code, message) => Object.assign(new Error(message), { code });
const snapshot = (room) => JSON.parse(JSON.stringify(room));
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    );
  return value;
}
const checksum = (room) => sha(JSON.stringify(canonical(room)));
async function migrateGames(pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(71638204)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS bx_migrations(name TEXT PRIMARY KEY,checksum TEXT NOT NULL,applied_at BIGINT NOT NULL)",
    );
    for (const migration of migrationFiles()) {
      const prior = (
        await client.query("SELECT checksum FROM bx_migrations WHERE name=$1", [
          migration.name,
        ])
      ).rows[0];
      if (prior) {
        if (prior.checksum !== sha(migration.sql))
          throw error(
            "MIGRATION_CHANGED",
            "Applied migration checksum changed.",
          );
        continue;
      }
      await client.query(migration.sql);
      await client.query(
        "INSERT INTO bx_migrations(name,checksum,applied_at) VALUES($1,$2,$3)",
        [migration.name, sha(migration.sql), Date.now()],
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
const { finalResults } = require("./results");
class GameStore {
  constructor(pool, owner, epoch) {
    this.pool = pool;
    this.owner = owner;
    this.epoch = epoch;
    this.available = true;
    this.knownMatches = new Set();
  }
  async transaction(work) {
    if (!this.available)
      throw error(
        "STORAGE_UNAVAILABLE",
        "Game storage is unavailable; no move was committed.",
      );
    const client = await this.pool.connect();
    try {
      // One protocol round trip; the fencing row remains locked until COMMIT.
      const control = await client.query(
        `BEGIN; SELECT set_config('statement_timeout','${RULES.storageTimeoutMs}',true),set_config('idle_in_transaction_session_timeout','${RULES.storageTimeoutMs + 5000}',true); SELECT epoch FROM bx_service_owner WHERE id=1 FOR SHARE`,
      );
      const ownership = control.at(-1).rows[0];
      if (Number(ownership?.epoch) !== this.epoch) {
        this.available = false;
        throw error("SERVER_FENCED", "Another server owns the game state.");
      }
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
  async load() {
    const rows = (
      await this.pool.query(
        "SELECT state,version,checksum,schema_version FROM bx_rooms WHERE status<>'closed' ORDER BY updated_at",
      )
    ).rows;
    return rows.map((row) => {
      const state = row.state;
      if (
        row.schema_version !== 1 ||
        checksum(state) !== row.checksum ||
        Number(state.version) !== Number(row.version)
      )
        throw error(
          "CORRUPT_SNAPSHOT",
          "A stored room failed integrity validation; startup stopped.",
        );
      if (state.matchId) this.knownMatches.add(state.matchId);
      return state;
    });
  }
  async loadRoom(code) {
    const row = (
      await this.pool.query(
        "SELECT state,checksum FROM bx_rooms WHERE room_code=$1",
        [code],
      )
    ).rows[0];
    if (!row) return null;
    if (checksum(row.state) !== row.checksum)
      throw error("CORRUPT_SNAPSHOT", "Stored room integrity failure.");
    return row.state;
  }
  async receiptAnywhere(seatId, actionId) {
    return (
      await this.pool.query(
        "SELECT fingerprint,acknowledgement FROM bx_actions WHERE player_id=$1 AND action_id=$2",
        [seatId, actionId],
      )
    ).rows[0];
  }
  async receipt(roomCode, seatId, actionId) {
    return (
      await this.pool.query(
        "SELECT fingerprint,acknowledgement FROM bx_actions WHERE room_code=$1 AND player_id=$2 AND action_id=$3",
        [roomCode, seatId, actionId],
      )
    ).rows[0];
  }
  async commit(room, expected, receipt) {
    const now = Date.now();
    let receiptWritten = false;
    const answer = await this.transaction(async (client) => {
      if (room.phase === "finished" && room.matchId)
        await this.rankingPolicy(client, room, now);
      const state = room,
        data = JSON.stringify(state);
      if (expected === 0) {
        await client.query(
          "INSERT INTO bx_rooms(room_code,version,schema_version,status,state,checksum,next_deadline,updated_at) VALUES($1,$2,1,$3,$4,$5,$6,$7)",
          [
            room.id,
            room.version,
            room.closed ? "closed" : room.phase,
            data,
            checksum(state),
            room.nextWakeAt || null,
            now,
          ],
        );
      } else if (receipt) {
        const saved = await client.query(
          `WITH saved AS (
          UPDATE bx_rooms SET version=$2,status=$3,state=$4,checksum=$5,next_deadline=$6,updated_at=$7,completed_at=$8
          WHERE room_code=$1 AND version=$9 RETURNING version
        ) INSERT INTO bx_actions(room_code,player_id,action_id,fingerprint,acknowledgement,created_at)
          SELECT $1,$10,$11,$12,$13,$7 FROM saved RETURNING action_id`,
          [
            room.id,
            room.version,
            room.closed ? "closed" : room.phase,
            data,
            checksum(state),
            room.nextWakeAt || null,
            now,
            room.phase === "finished" || room.closed
              ? room.completedAt || now
              : null,
            expected,
            receipt.seatId,
            receipt.actionId,
            receipt.fingerprint,
            JSON.stringify(receipt.ack),
          ],
        );
        if (!saved.rowCount)
          throw error(
            "VERSION_CONFLICT",
            "The room changed; refresh before retrying.",
          );
        receiptWritten = true;
      } else {
        const saved = await client.query(
          "UPDATE bx_rooms SET version=$2,status=$3,state=$4,checksum=$5,next_deadline=$6,updated_at=$7,completed_at=$8 WHERE room_code=$1 AND version=$9 RETURNING version",
          [
            room.id,
            room.version,
            room.closed ? "closed" : room.phase,
            data,
            checksum(state),
            room.nextWakeAt || null,
            now,
            room.phase === "finished" || room.closed
              ? room.completedAt || now
              : null,
            expected,
          ],
        );
        if (!saved.rowCount)
          throw error(
            "VERSION_CONFLICT",
            "The room changed; refresh before retrying.",
          );
      }
      if (room.matchId) {
        if (!this.knownMatches.has(room.matchId)) {
          await client.query(
            "INSERT INTO bx_matches(match_id,room_code,mode,started_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
            [room.matchId, room.id, room.mode, room.startedAt || now],
          );
          await client.query(
            `INSERT INTO bx_participants(match_id,player_id,user_id,name,avatar,is_bot,joined_at)
            SELECT $1,p.player_id,p.user_id,p.name,p.avatar,p.is_bot,p.joined_at FROM jsonb_to_recordset($2::jsonb)
            AS p(player_id text,user_id text,name text,avatar int,is_bot boolean,joined_at bigint) ON CONFLICT DO NOTHING`,
            [
              room.matchId,
              JSON.stringify(
                (room.participants || []).map((p) => ({
                  player_id: p.id,
                  user_id: p.accountId || null,
                  name: p.name,
                  avatar: p.avatar || 0,
                  is_bot: !!p.isBot,
                  joined_at: p.joinedAt || room.startedAt || now,
                })),
              ),
            ],
          );
        }
        if (room.phase === "finished" || room.closed)
          await this.finalize(client, room, now);
      }
      if (receipt && !receiptWritten)
        await client.query(
          "INSERT INTO bx_actions(room_code,player_id,action_id,fingerprint,acknowledgement,created_at) VALUES($1,$2,$3,$4,$5,$6)",
          [
            room.id,
            receipt.seatId,
            receipt.actionId,
            receipt.fingerprint,
            JSON.stringify(receipt.ack),
            now,
          ],
        );
      return receipt?.ack;
    });
    if (room.matchId) this.knownMatches.add(room.matchId);
    if (this.knownMatches.size > RULES.maxRooms * 2)
      this.knownMatches.delete(this.knownMatches.values().next().value);
    return answer;
  }
  async finalize(client, room, now) {
    const results = finalResults(room),
      ranked = !!results[0]?.ranked;
    const updated = await client.query(
      "UPDATE bx_matches SET finalized=TRUE,completed_at=$2,rounds=$3,winner_id=$4,outcome_reason=$5,ranked=$6,summary=$7 WHERE match_id=$1 AND finalized=FALSE RETURNING match_id",
      [
        room.matchId,
        now,
        room.roundNumber,
        room.winnerId || null,
        room.abandoned ? "abandoned" : room.winReason || "cards",
        ranked,
        room.insights
          ? JSON.stringify(
              (({ players, awards, ...aggregate }) => aggregate)(
                require("./match-insights").summary(room),
              ),
            )
          : null,
      ],
    );
    if (!updated.rowCount) return;
    const resultRows = results.map((r) => ({
      player_id: r.playerId,
      user_id: r.userId,
      placement: r.placement,
      won: r.won,
      forfeit: r.forfeit,
      ai_assisted: r.aiAssisted,
      ranked: r.ranked,
      score: r.score,
      calls: r.calls,
      correct_calls: r.correct,
      outcome_reason: r.reason,
    }));
    await client.query(
      `WITH inserted AS (
      INSERT INTO bx_results(match_id,player_id,user_id,placement,won,forfeit,ai_assisted,ranked,score,calls,correct_calls,outcome_reason)
      SELECT $1,p.player_id,p.user_id,p.placement,p.won,p.forfeit,p.ai_assisted,p.ranked,p.score,p.calls,p.correct_calls,p.outcome_reason
      FROM jsonb_to_recordset($2::jsonb) AS p(player_id text,user_id text,placement integer,won boolean,forfeit boolean,ai_assisted boolean,ranked boolean,score integer,calls integer,correct_calls integer,outcome_reason text)
      ON CONFLICT DO NOTHING RETURNING user_id,ranked,won,forfeit,ai_assisted,calls,correct_calls
    ) INSERT INTO bx_player_stats(user_id,games,wins,losses,forfeits,ai_assisted,unranked_games,calls,correct_calls,updated_at)
      SELECT user_id,CASE WHEN ranked THEN 1 ELSE 0 END,CASE WHEN ranked AND won THEN 1 ELSE 0 END,
        CASE WHEN ranked AND NOT won THEN 1 ELSE 0 END,CASE WHEN forfeit THEN 1 ELSE 0 END,
        CASE WHEN ai_assisted THEN 1 ELSE 0 END,CASE WHEN ranked THEN 0 ELSE 1 END,calls,correct_calls,$3
      FROM inserted WHERE user_id IS NOT NULL
      ON CONFLICT(user_id) DO UPDATE SET games=bx_player_stats.games+EXCLUDED.games,wins=bx_player_stats.wins+EXCLUDED.wins,
        losses=bx_player_stats.losses+EXCLUDED.losses,forfeits=bx_player_stats.forfeits+EXCLUDED.forfeits,
        ai_assisted=bx_player_stats.ai_assisted+EXCLUDED.ai_assisted,unranked_games=bx_player_stats.unranked_games+EXCLUDED.unranked_games,
        calls=bx_player_stats.calls+EXCLUDED.calls,correct_calls=bx_player_stats.correct_calls+EXCLUDED.correct_calls,updated_at=EXCLUDED.updated_at`,
      [room.matchId, JSON.stringify(resultRows), now],
    );
    await require("./progression").unlock(client, room, results, now);
  }
  async rankingPolicy(client, room, now) {
    const old = (
      await client.query(
        "SELECT finalized,ranked FROM bx_matches WHERE match_id=$1",
        [room.matchId],
      )
    ).rows[0];
    if (old?.finalized) {
      room.rankEligibility = old.ranked;
      return;
    }
    if (!finalResults(room)[0]?.ranked) return;
    const winner = room.participants.find((p) => p.id === room.winnerId);
    const pairs = room.participants
      .filter((p) => p.accountId && p.id !== winner.id)
      .map((p) => [winner.accountId, p.accountId].sort().join(":"))
      .sort();
    await client.query("SAVEPOINT ranked_budget");
    const limit = RULES.rankedPairDailyLimit;
    for (const pair of pairs) {
      const saved = await client.query(
        "INSERT INTO bx_ranked_pairs(day,pair,games) VALUES($1,$2,1) ON CONFLICT(day,pair) DO UPDATE SET games=bx_ranked_pairs.games+1 WHERE bx_ranked_pairs.games<$3 RETURNING games",
        [new Date(now).toISOString().slice(0, 10), pair, limit],
      );
      if (!saved.rowCount) {
        await client.query("ROLLBACK TO SAVEPOINT ranked_budget");
        room.rankEligibility = false;
        room.rankReason = "daily_pair_limit";
        break;
      }
    }
    await client.query("RELEASE SAVEPOINT ranked_budget");
  }
  async stats(userId) {
    const r =
      (
        await this.pool.query(
          "SELECT * FROM bx_player_stats WHERE user_id=$1",
          [userId],
        )
      ).rows[0] || {};
    return {
      games: Number(r.games || 0),
      wins: Number(r.wins || 0),
      losses: Number(r.losses || 0),
      forfeits: Number(r.forfeits || 0),
      aiAssisted: Number(r.ai_assisted || 0),
      unrankedGames: Number(r.unranked_games || 0),
      calls: Number(r.calls || 0),
      correct: Number(r.correct_calls || 0),
      winRate:
        Number(r.games) > 0
          ? Math.round((Number(r.wins) / Number(r.games)) * 100)
          : 0,
    };
  }
  async leaderboard(page = 0, limit = 20) {
    const rows = (
      await this.pool.query(
        `SELECT u.id,u.name,u.avatar,a.id AS avatar_id,s.games,s.wins,s.losses,
      RANK() OVER(ORDER BY s.wins DESC, (s.wins::numeric / NULLIF(s.games,0)) DESC) AS ranking,
      COUNT(*) OVER() AS total FROM bx_player_stats s JOIN users u ON u.id=s.user_id LEFT JOIN player_avatars a ON a.user_id=u.id WHERE s.games>0
      ORDER BY s.wins DESC,(s.wins::numeric / NULLIF(s.games,0)) DESC,u.id LIMIT $1 OFFSET $2`,
        [limit, page * limit],
      )
    ).rows;
    return {
      page,
      limit,
      total: Number(rows[0]?.total || 0),
      players: rows.map((r) => ({
        id: r.id,
        name: r.name,
        avatar: r.avatar,
        avatarId: r.avatar_id || null,
        rank: Number(r.ranking),
        games: Number(r.games),
        wins: Number(r.wins),
        losses: Number(r.losses),
        winRate: Math.round((Number(r.wins) / Number(r.games)) * 100),
      })),
    };
  }
  async prune(now = Date.now()) {
    // Retire private snapshots/actions; retain authoritative match/results/statistics.
    await this.transaction(async (c) => {
      await c.query(
        "DELETE FROM bx_rooms WHERE completed_at<$1 AND status IN ('closed','finished')",
        [now - RULES.retentionMs],
      );
      await c.query("DELETE FROM bx_ranked_pairs WHERE day<$1", [
        new Date(now - 30 * 86400000).toISOString().slice(0, 10),
      ]);
    });
  }
  async eraseAccount(id) {
    await this.transaction(async (c) => {
      await c.query(
        "DELETE FROM bx_rooms WHERE status IN ('closed','finished') AND (state @> $1::jsonb OR state @> $2::jsonb)",
        [
          JSON.stringify({ players: [{ accountId: id }] }),
          JSON.stringify({ participants: [{ accountId: id }] }),
        ],
      );
      await c.query(
        "UPDATE bx_participants SET user_id=NULL,name='Deleted player',avatar=0 WHERE user_id=$1",
        [id],
      );
      await c.query("UPDATE bx_results SET user_id=NULL WHERE user_id=$1", [
        id,
      ]);
      await c.query("DELETE FROM bx_player_stats WHERE user_id=$1", [id]);
      await c.query("DELETE FROM bx_reports WHERE user_id=$1", [id]);
    });
  }
  async close() {
    this.available = false;
    await this.owner?.end();
    await this.pool.end();
  }
}
async function openGameStore({
  connectionString = process.env.DATABASE_URL,
  directUrl = process.env.DATABASE_URL_UNPOOLED,
  autoMigrate = process.env.GAME_AUTO_MIGRATE === "true",
} = {}) {
  if (!connectionString)
    throw error(
      "STORAGE_REQUIRED",
      "PostgreSQL is required for all game modes.",
    );
  if (!directUrl && /-pooler\./.test(new URL(connectionString).hostname))
    throw error(
      "DIRECT_URL_REQUIRED",
      "DATABASE_URL_UNPOOLED is required for exclusive server ownership.",
    );
  const pool = new Pool({
    connectionString: verifiedConnectionString(connectionString),
    max: RULES.gamePoolSize,
    connectionTimeoutMillis: RULES.storageTimeoutMs,
    query_timeout: RULES.storageTimeoutMs + 5000,
  });
  const owner = new Client({
    connectionString: verifiedConnectionString(directUrl || connectionString),
    connectionTimeoutMillis: RULES.storageTimeoutMs,
    query_timeout: RULES.storageTimeoutMs + 5000,
    keepAlive: true,
  });
  let store;
  try {
    if (autoMigrate) {
      const migrationPool = new Pool({
        connectionString: verifiedConnectionString(
          directUrl || connectionString,
        ),
        max: 1,
      });
      try {
        await migrateGames(migrationPool);
      } finally {
        await migrationPool.end();
      }
    }
    let applied;
    try {
      applied = (await pool.query("SELECT name,checksum FROM bx_migrations"))
        .rows;
    } catch (e) {
      if (e.code === "42P01")
        throw error(
          "MIGRATION_REQUIRED",
          "The configured database has no BluffX game schema. Run npm run db:migrate-games against the intended database before starting. Use an isolated Neon branch for local development; apply production migrations only during your planned maintenance window.",
        );
      throw e;
    }
    if (
      migrationFiles().some(
        (m) =>
          !applied.some(
            (row) => row.name === m.name && row.checksum === sha(m.sql),
          ),
      )
    )
      throw error(
        "MIGRATION_REQUIRED",
        "Run npm run db:migrate-games on the intended database before starting.",
      );
    await owner.connect();
    if (
      !(await owner.query("SELECT pg_try_advisory_lock(71638205) AS owned"))
        .rows[0].owned
    )
      throw error(
        "SERVER_ALREADY_RUNNING",
        "Only one BluffX game server may own this database.",
      );
    const epoch = Number(
      (
        await owner.query(
          "UPDATE bx_service_owner SET epoch=epoch+1 WHERE id=1 RETURNING epoch",
        )
      ).rows[0].epoch,
    );
    store = new GameStore(pool, owner, epoch);
    owner.on("error", (e) => {
      store.unavailableReason = e.code || "OWNER_ERROR";
      store.available = false;
      store.onUnavailable?.();
    });
    owner.on("end", () => {
      store.unavailableReason ||= "OWNER_CONNECTION_ENDED";
      store.available = false;
      store.onUnavailable?.();
    });
    pool.on("error", () => {});
    return store;
  } catch (e) {
    await owner.end().catch(() => {});
    await pool.end();
    throw e;
  }
}
async function createGameStore(options = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await openGameStore(options);
    } catch (e) {
      const transient =
        [
          "ECONNRESET",
          "ETIMEDOUT",
          "ECONNREFUSED",
          "EPIPE",
          "57P01",
          "57P02",
          "57P03",
        ].includes(e.code) ||
        /^08/.test(e.code || "") ||
        /connection (?:terminated|timeout)/i.test(e.message || "");
      if (!transient || attempt >= RULES.storageConnectAttempts) throw e;
      // Retry only connection/startup work, never a gameplay mutation.
      await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
}
module.exports = {
  createGameStore,
  GameStore,
  migrateGames,
  finalResults,
  snapshot,
  checksum,
  error,
};
