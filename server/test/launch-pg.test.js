const test = require("node:test"),
  assert = require("node:assert/strict"),
  crypto = require("node:crypto");
const { createGameStore } = require("../src/game-store");
const { RoomService } = require("../src/room-service");
const { supervise } = require("../src/recovery");
const { startServer } = require("../src/index");
const { envelope } = require("../src/protocol");
const { io } = require("../../client/node_modules/socket.io-client");
const URL = process.env.TEST_DATABASE_URL;
test(
  "real PostgreSQL: a terminated owner connection restarts the server and recovers the exact seat",
  { skip: !URL, timeout: 180000 },
  async () => {
    const controller = new AbortController();
    let instance,
      port = 0,
      generation = 0,
      ready;
    const first = new Promise((r) => (ready = r));
    const run = supervise(
      async () => {
        const store = await createGameStore({
          connectionString: URL,
          directUrl: URL,
        });
        return startServer({ port, store });
      },
      {
        signal: controller.signal,
        sleep: async () => {},
        onReady: (s) => {
          instance = s;
          port = s.server.address().port;
          generation++;
          ready?.();
        },
      },
    );
    await first;
    let token = "",
      proposal = "",
      latest,
      active = true;
    const socket = io("http://localhost:" + port, {
      autoConnect: false,
      transports: ["websocket"],
      reconnectionDelay: 100,
      reconnectionDelayMax: 300,
      auth: (cb) => {
        proposal = crypto.randomBytes(32).toString("hex");
        cb({ resumeToken: token, nextResumeToken: proposal, stateProtocol: 1 });
      },
    });
    socket.on("seat_session", () => {
      token = proposal;
    });
    socket.on("room_state", (s) => {
      latest = s;
    });
    const event = (name, predicate = () => true) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          socket.off(name, fn);
          reject(Error("Timeout " + name));
        }, 45000);
        const fn = (data) => {
          if (predicate(data)) {
            clearTimeout(timer);
            socket.off(name, fn);
            resolve(data);
          }
        };
        socket.on(name, fn);
      });
    const retry = () => {
      if (active)
        setTimeout(() => {
          if (active && !socket.connected) socket.connect();
        }, 150);
    };
    socket.on("disconnect", retry);
    socket.on("connect_error", retry);
    const send = (name, data = {}) =>
      new Promise((resolve, reject) =>
        socket
          .timeout(15000)
          .emit(
            name,
            {
              ...envelope(latest || { roundNumber: 1 }),
              ...data,
              actionId: crypto.randomUUID(),
            },
            (err, r) => {
              return err
                ? reject(err)
                : r.ok
                  ? resolve(r)
                  : reject(Error(r.code));
            },
          ),
      );
    try {
      let wait = event("server_ready");
      socket.connect();
      await wait;
      wait = event("room_state");
      await send("create_ai_room", { name: "Owner Recovery", botCount: 1 });
      await wait;
      wait = event("room_state", (s) => s.phase === "playing");
      await send("start_game");
      await wait;
      const before = JSON.parse(JSON.stringify(latest)),
        oldEpoch = instance.store.epoch;
      wait = event(
        "room_state",
        (s) =>
          s.matchId === before.matchId && s.you?.connected && generation >= 2,
      );
      const ownerPid = (
        await instance.store.owner.query("SELECT pg_backend_pid() AS pid")
      ).rows[0].pid;
      assert.equal(
        (
          await instance.store.pool.query(
            "SELECT pg_terminate_backend($1) AS stopped",
            [ownerPid],
          )
        ).rows[0].stopped,
        true,
      );
      const after = await wait;
      assert.deepEqual(after.hand, before.hand);
      assert.equal(after.you.id, before.you.id);
      assert.equal(after.turnSequence, before.turnSequence);
      assert.ok(instance.store.epoch > oldEpoch);
    } finally {
      active = false;
      controller.abort();
      socket.disconnect();
      await run;
    }
  },
);

test(
  "real PostgreSQL: same-opponent budget is atomic, durable and account erasure retains anonymous results",
  { skip: !URL, timeout: 180000 },
  async () => {
    const store = await createGameStore({
      connectionString: URL,
      directUrl: URL,
    });
    const service = new RoomService(store),
      ids = [crypto.randomUUID(), crypto.randomUUID()];
    const actors = ids.map((accountId) => ({
      id: crypto.randomUUID(),
      accountId,
      generation: 1,
      profile: { emailVerified: true },
      proposal: crypto.randomBytes(32).toString("hex"),
    }));
    const codes = [];
    try {
      await service.initialize();
      for (let i = 0; i < 2; i++)
        await store.pool.query(
          "INSERT INTO users(id,email,name,email_verified,created_at) VALUES($1,$2,$3,1,$4)",
          [ids[i], `launch-${ids[i]}@example.com`, "Launch " + i, Date.now()],
        );
      for (let n = 0; n < 4; n++) {
        const { roomId } = await service.create(actors[0], {
          name: "Launch Winner",
          maxPlayers: 2,
          actionId: crypto.randomUUID(),
        });
        codes.push(roomId);
        await service.join(roomId, actors[1], {
          name: "Launch Peer",
          actionId: crypto.randomUUID(),
        });
        const cmd = (who, event, data = {}) =>
          service.command(roomId, who, event, {
            ...envelope(service.rooms.get(roomId)),
            ...data,
            actionId: crypto.randomUUID(),
          });
        await cmd(actors[1], "set_ready", { ready: true });
        await cmd(actors[0], "start_game");
        await cmd(actors[1], "leave_room");
        const saved = await store.loadRoom(roomId);
        assert.equal(saved.rankEligibility === false, n === 3);
        await cmd(actors[0], "leave_room");
      }
      const stats = await store.stats(ids[0]);
      assert.equal(stats.games, 3);
      assert.equal(stats.wins, 3);
      await service.eraseAccount(ids[0]);
      assert.equal(
        Number(
          (
            await store.pool.query(
              "SELECT COUNT(*) AS n FROM bx_participants WHERE user_id=$1",
              [ids[0]],
            )
          ).rows[0].n,
        ),
        0,
      );
      assert.equal(
        Number(
          (
            await store.pool.query(
              "SELECT COUNT(*) AS n FROM bx_results WHERE user_id=$1",
              [ids[0]],
            )
          ).rows[0].n,
        ),
        0,
      );
    } catch (e) {
      console.log(
        "Ranking test failure reason",
        e.code || e.name,
        "owner",
        store.unavailableReason || "available",
      );
      throw e;
    } finally {
      for (const id of ids) {
        await store.pool.query("DELETE FROM bx_reports WHERE user_id=$1", [id]);
        await store.pool.query("DELETE FROM users WHERE id=$1", [id]);
      }
      for (const code of codes)
        await store.pool.query("DELETE FROM bx_rooms WHERE room_code=$1", [
          code,
        ]);
      await store.close();
    }
  },
);
