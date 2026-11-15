const test = require("node:test"),
  assert = require("node:assert/strict"),
  crypto = require("node:crypto");
const { createGameStore } = require("../src/game-store");
const { startServer } = require("../src/index");
const { conditions, season } = require("../src/progression");
const URL = process.env.TEST_DATABASE_URL;
test(
  "v3 real PostgreSQL: social privacy, requests, blocks, invites, history and authoritative achievement transactions",
  { skip: !URL, timeout: 180000 },
  async () => {
    const store = await createGameStore({
      connectionString: URL,
      directUrl: URL,
      autoMigrate: true,
    });
    const instance = await startServer({ port: 0, store }),
      base = "http://localhost:" + instance.server.address().port;
    const users = [];
    const call = async (user, path, body) => {
      const r = await fetch(base + "/auth/" + path, {
        method: body ? "POST" : "GET",
        headers: {
          cookie: user.cookie,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      // Model separate real browsers: retain the signed identity cookie issued
      // by auth reads instead of collapsing every user into the loopback IP bucket.
      const cookies = new Map(user.cookie.split(/;\s*/).map((part) => {
        const index = part.indexOf("=");
        return [part.slice(0, index), part.slice(index + 1)];
      }));
      for (const header of r.headers.getSetCookie()) {
        const pair = header.split(";", 1)[0];
        const index = pair.indexOf("=");
        cookies.set(pair.slice(0, index), pair.slice(index + 1));
      }
      user.cookie = [...cookies].map(([key, value]) => `${key}=${value}`).join("; ");
      const text = await r.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = {};
      }
      return { status: r.status, data };
    };
    try {
      for (let i = 0; i < 3; i++) {
        const id = crypto.randomUUID(),
          token = crypto.randomBytes(32).toString("hex");
        await store.pool.query(
          "INSERT INTO users(id,email,name,avatar,email_verified,created_at) VALUES($1,$2,$3,0,1,$4)",
          [id, `v3-${id}@example.com`, `V3 ${i}`, Date.now()],
        );
        await store.pool.query(
          "INSERT INTO sessions(hash,user_id,expires_at) VALUES($1,$2,$3)",
          [
            crypto.createHash("sha256").update(token).digest("hex"),
            id,
            Date.now() + 3600000,
          ],
        );
        const user = { id, cookie: "bluffx_session=" + token };
        users.push(user);
        const r = await call(user, "social");
        assert.equal(r.status, 200);
        user.handle = r.data.profile.handle;
        assert.ok(!JSON.stringify(r.data).includes(user.id));
      }
      const [a, b, c] = users;
      assert.equal(new Set(users.map((u) => u.handle)).size, 3);
      for (const user of users) {
        const card = await call(user, "social/card");
        assert.equal(card.status, 200);
        assert.equal(card.data.handle, user.handle);
        assert.ok(!JSON.stringify(card.data).includes(user.id));
        assert.equal(
          (await call(user, "social/card")).data.handle,
          user.handle,
        );
      }
      await store.pool.query("UPDATE users SET email_verified=0 WHERE id=$1", [
        c.id,
      ]);
      assert.equal((await call(c, "social/card")).data.handle, c.handle);
      assert.equal((await call(c, "social")).status, 403);
      await store.pool.query("UPDATE users SET email_verified=1 WHERE id=$1", [
        c.id,
      ]);
      const formattedB = b.handle
        .toUpperCase()
        .match(/.{1,4}/g)
        .join("-");
      const search = await call(a, "social/search?handle=" + formattedB);
      assert.equal(search.status, 200);
      assert.equal(search.data.players[0].handle, b.handle);
      assert.equal(
        (
          await call(a, "social/action", {
            handle: formattedB,
            action: "request",
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await call(a, "social/action", {
            handle: b.handle,
            action: "request",
          })
        ).status,
        409,
      );
      assert.equal(
        (await call(c, "social/action", { handle: a.handle, action: "accept" }))
          .status,
        409,
      );
      assert.equal(
        (await call(b, "social/action", { handle: a.handle, action: "accept" }))
          .status,
        200,
      );
      assert.equal(
        (await call(a, "social")).data.players[0].status,
        "accepted",
      );
      const room = {
        id: "V3TEST",
        phase: "lobby",
        players: [{ accountId: a.id }],
        maxPlayers: 2,
        passwordHash: "secret",
        closed: false,
      };
      instance.service.rooms.set(room.id, room);
      assert.equal(
        (await call(a, "social/invite", { handle: b.handle, roomId: room.id }))
          .status,
        200,
      );
      assert.equal(
        (await call(a, "social/invite", { handle: b.handle, roomId: room.id }))
          .status,
        409,
      );
      const invite = (await call(b, "social")).data.invites[0];
      assert.equal(
        (await call(c, "social/invite/" + invite.token)).status,
        410,
      );
      const opened = await call(b, "social/invite/" + invite.token);
      assert.equal(opened.data.passwordRequired, true);
      assert.ok(!JSON.stringify(opened).includes("secret"));
      room.players.push({ accountId: c.id });
      assert.equal(
        (await call(b, "social/invite/" + invite.token)).status,
        409,
      );
      room.players.pop();
      await store.pool.query(
        "UPDATE bx_invites SET expires_at=0 WHERE token=$1",
        [invite.token],
      );
      assert.equal(
        (await call(b, "social/invite/" + invite.token)).status,
        410,
      );
      assert.equal(
        (await call(b, "social/action", { handle: a.handle, action: "remove" }))
          .status,
        200,
      );
      assert.equal((await call(a, "social")).data.players.length, 0);
      assert.equal(
        (
          await call(a, "social/action", {
            handle: b.handle,
            action: "request",
          })
        ).status,
        409,
      );
      assert.equal(
        (await call(b, "social/action", { handle: a.handle, action: "block" }))
          .status,
        200,
      );
      assert.equal(
        (await call(a, "social/search?handle=" + b.handle)).data.players.length,
        0,
      );
      assert.equal(
        (
          await call(a, "social/action", {
            handle: b.handle,
            action: "request",
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await call(b, "social/preferences", {
            requests: false,
            invites: false,
            recent: false,
          })
        ).status,
        200,
      );
      assert.deepEqual((await call(a, "history")).data.items, []);
      assert.equal((await call(a, "achievements")).status, 200);
      assert.equal((await call(a, "season")).status, 200);
      assert.equal(
        (await call(a, "achievements", { achievement: "first_victory" }))
          .status,
        404,
      );
      instance.service.rooms.delete(room.id);
      // Finalization is tested through the real existing transaction, not a client result endpoint.
      const id = crypto.randomUUID(),
        now = Date.now(),
        r = {
          matchId: id,
          mode: "multiplayer",
          winnerId: "a",
          participants: [
            { id: "a", accountId: a.id, emailVerified: true },
            { id: "b", accountId: b.id, emailVerified: true },
          ],
          hands: { a: [], b: [{}] },
          matchScores: {},
          rules: { requireVerifiedRanked: true },
          roundNumber: 2,
          completedRounds: 1,
          startedAt: now - 1000,
          completedAt: now,
          deckCount: 2,
          insights: {
            a: { challenges: 3, challengesWon: 3, unchallengedBluffs: 1 },
            b: { challenges: 0 },
          },
          winReason: "cards",
        };
      await store.pool.query(
        "INSERT INTO bx_matches(match_id,room_code,mode,started_at) VALUES($1,$2,$3,$4)",
        [id, "V3HIST", "multiplayer", now - 1000],
      );
      for (const p of r.participants)
        await store.pool.query(
          "INSERT INTO bx_participants(match_id,player_id,user_id,name,avatar,is_bot,joined_at) VALUES($1,$2,$3,$4,0,FALSE,$5)",
          [id, p.id, p.accountId, "Private Name", now],
        );
      await store.pool.query(
        "INSERT INTO bx_player_stats(user_id,correct_calls,updated_at) VALUES($1,99,$2) ON CONFLICT(user_id) DO UPDATE SET correct_calls=99",
        [a.id, now],
      );
      const client = await store.pool.connect();
      try {
        await client.query("BEGIN");
        await store.finalize(client, r, now);
        await store.finalize(client, r, now);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
      const achievements = (await call(a, "achievements")).data.items;
      assert.equal(
        achievements.filter((x) => x.achievement === "first_victory").length,
        1,
      );
      assert.ok(achievements.some((x) => x.achievement === "double_trouble"));
      assert.ok(
        !achievements.some((x) => x.achievement === "five_challenges"),
        "prior practice challenge counters cannot unlock ranked achievements",
      );
      const history = (await call(a, "history")).data.items;
      assert.equal(history.length, 1);
      assert.equal(history[0].deckCount, 2);
      assert.equal(history[0].winner_name, "You");
      assert.deepEqual(history[0].participants.sort(), [
        "Private player",
        "You",
      ]);
      assert.equal((await call(a, "social/recent")).status, 200);
      assert.deepEqual((await call(a, "social/recent")).data.players, []);
      assert.ok(!JSON.stringify(history).includes("Private Name"));
      assert.equal((await call(c, "history")).data.items.length, 0);
      assert.ok(
        (await call(a, "season")).data.items.some((x) => x.name === "V3 0"),
      );
      // Isolated, legacy-style fixtures exercise pagination, not a client result-writing API.
      const prefix = crypto.randomUUID();
      await store.pool.query(
        "INSERT INTO bx_matches(match_id,room_code,mode,started_at,completed_at,finalized) SELECT $1||':'||n::text,'PAGE','multiplayer',$2::bigint,$2::bigint+n,TRUE FROM generate_series(1,21) n",
        [prefix, Date.now()],
      );
      await store.pool.query(
        "INSERT INTO bx_participants(match_id,player_id,user_id,name,avatar,is_bot,joined_at) SELECT match_id,'page-seat',$2,'History fixture',0,FALSE,started_at FROM bx_matches WHERE match_id LIKE $1",
        [prefix + ":%", a.id],
      );
      await store.pool.query(
        "INSERT INTO bx_results(match_id,player_id,user_id,placement,won,forfeit,ai_assisted,ranked,score,calls,correct_calls,outcome_reason) SELECT match_id,'page-seat',$2,1,TRUE,FALSE,FALSE,FALSE,0,0,0,'fixture' FROM bx_matches WHERE match_id LIKE $1",
        [prefix + ":%", a.id],
      );
      const firstPage = (await call(a, "history?page=0")).data,
        secondPage = (await call(a, "history?page=1")).data;
      assert.equal(firstPage.items.length, 20);
      assert.equal(firstPage.hasMore, true);
      assert.equal(secondPage.items.length, 2);
      assert.equal(secondPage.hasMore, false);
      assert.equal(
        new Set(
          [...firstPage.items, ...secondPage.items].map((x) => x.match_id),
        ).size,
        22,
      );
      assert.equal((await call(c, "history")).data.items.length, 0);
    } finally {
      instance.service.rooms.delete("V3TEST");
      for (const u of users)
        await store.pool.query("DELETE FROM users WHERE id=$1", [u.id]);
      await instance.close();
    }
  },
);
test("server-defined UTC seasons and ranked-only achievements exclude AI/practice/forfeits", () => {
  assert.equal(season(Date.UTC(2026, 2, 31, 23, 59)).id, "2026-Q1");
  assert.equal(season(Date.UTC(2026, 3, 1)).id, "2026-Q2");
  const r = {
    participants: Array(8),
    deckCount: 2,
    insights: { p: { challenges: 3, challengesWon: 3, unchallengedBluffs: 1 } },
  };
  assert.deepEqual(
    conditions(
      r,
      { playerId: "p", ranked: false, won: true },
      { wins: 10, games: 10 },
    ),
    [],
  );
  assert.deepEqual(
    conditions(
      r,
      { playerId: "p", ranked: true, won: true, aiAssisted: true },
      { wins: 10, games: 10 },
    ),
    [],
  );
  assert.ok(
    conditions(
      r,
      { playerId: "p", ranked: true, won: true },
      { wins: 10, games: 10 },
    ).includes("perfect_challenges"),
  );
});
