const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");
const { io } = require("./socket-client.cjs");
const { Pool } = require("pg");
const { verifiedConnectionString } = require("../src/database");
const URL = process.env.TEST_DATABASE_URL;
const event = (socket, name, predicate = () => true) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(name, fn);
      reject(Error("Timeout " + name));
    }, 25000);
    function fn(v) {
      if (predicate(v)) {
        clearTimeout(timer);
        socket.off(name, fn);
        resolve(v);
      }
    }
    socket.on(name, fn);
  });
test(
  "abrupt real server termination and fresh Socket.IO clients recover the committed match",
  { skip: !URL, timeout: 240000 },
  async () => {
    let child, code;
    const sockets = [];
    const db = new Pool({
      connectionString: verifiedConnectionString(URL),
      max: 1,
    });
    async function boot() {
      child = spawn(process.execPath, ["src/index.js"], {
        cwd: path.resolve(__dirname, ".."),
        env: {
          ...process.env,
          DATABASE_URL: URL,
          DATABASE_URL_UNPOOLED: URL,
          PORT: "4035",
          GAME_AUTO_MIGRATE: "false",
          NODE_ENV: "development",
          MAIL_PROVIDER: "local",
        },
        stdio: "pipe",
      });
      for (let i = 0; i < 600; i++) {
        if (child.exitCode !== null)
          throw Error("Test server exited before startup");
        try {
          if ((await fetch("http://localhost:4035/health")).ok) return;
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      throw Error("Test server did not start");
    }
    async function connect(token) {
      const s = io("http://localhost:4035", {
        autoConnect: false,
        reconnection: false,
        transports: ["websocket"],
        auth: { resumeToken: token || "" },
      });
      sockets.push(s);
      const connected = event(s, "connect");
      s.connect();
      await connected;
      return s;
    }
    try {
      await boot();
      const sharp = require("../node_modules/sharp");
      const photo = await sharp({
        create: { width: 32, height: 32, channels: 3, background: "#e62c88" },
      })
        .png()
        .toBuffer();
      const upload = await fetch("http://localhost:4035/auth/avatar", {
        method: "POST",
        headers: { "Content-Type": "image/png" },
        body: photo,
      });
      assert.equal(upload.status, 201);
      const avatarId = (await upload.json()).avatarId;
      const a = await connect(),
        b = await connect();
      let wait = event(a, "room_state"),
        aToken = event(a, "seat_session");
      a.emit("create_room", {
        name: "Restart A",
        avatarId,
        maxPlayers: 2,
        turnSeconds: 60,
      });
      const lobby = await wait;
      code = lobby.roomId;
      const tokenA = (await aToken).token;
      wait = event(b, "room_state");
      const bToken = event(b, "seat_session");
      b.emit("join_room", { roomId: code, name: "Restart B" });
      await wait;
      const tokenB = (await bToken).token;
      wait = event(a, "room_state", (s) => s.players.every((p) => p.ready));
      b.emit("set_ready", { roomId: code, ready: true });
      await wait;
      wait = event(a, "room_state", (s) => s.phase === "playing");
      a.emit("start_game", { roomId: code });
      const dealt = await wait;
      const originalSeat = dealt.you.id;
      wait = event(b, "room_state", (s) => !!s.lastMove);
      a.emit("play_cards", {
        roomId: code,
        cardIds: [dealt.hand[0].id],
        declaredRank: dealt.hand[0].rank,
      });
      const claimed = await wait;
      const old = (
        await db.query("SELECT state FROM bx_rooms WHERE room_code=$1", [code])
      ).rows[0].state;
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("exit", resolve));
      a.disconnect();
      b.disconnect();
      await boot();
      const anew = io("http://localhost:4035", {
        autoConnect: false,
        reconnection: false,
        transports: ["websocket"],
        auth: { resumeToken: tokenA },
      });
      sockets.push(anew);
      wait = event(anew, "room_state");
      anew.connect();
      const recovered = await wait;
      assert.equal(recovered.you.id, originalSeat);
      assert.equal(recovered.you.avatarId, avatarId);
      const restoredPhoto = await fetch(
        "http://localhost:4035/auth/avatar/" + avatarId,
      );
      assert.equal(restoredPhoto.status, 200);
      assert.equal(
        (await sharp(Buffer.from(await restoredPhoto.arrayBuffer())).metadata())
          .width,
        128,
      );
      assert.deepEqual(recovered.hand, old.hands[originalSeat]);
      assert.equal(recovered.matchId, old.matchId);
      assert.equal(recovered.turnEndsAt, old.turnEndsAt);
      assert.equal(recovered.turnSequence, old.turnSequence);
      assert.equal(recovered.roundId, old.roundId);
      assert.equal(recovered.players[0].resumeHash, undefined);
      assert.equal(recovered.hands, undefined);
      assert.ok(!JSON.stringify(recovered).includes(tokenA));
      const bnew = io("http://localhost:4035", {
        autoConnect: false,
        reconnection: false,
        transports: ["websocket"],
        auth: { resumeToken: tokenB },
      });
      sockets.push(bnew);
      wait = event(bnew, "room_state");
      bnew.connect();
      const restoredB = await wait;
      assert.equal(restoredB.you.id, claimed.you.id);
      assert.deepEqual(restoredB.hand, old.hands[claimed.you.id]);
      wait = event(anew, "room_state", (s) => s.phase === "round_result");
      bnew.emit("call_bluff", { roomId: code, selectedIndexes: [0] });
      await wait;
      const closed = (
        await db.query("SELECT state FROM bx_rooms WHERE room_code=$1", [code])
      ).rows[0].state;
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("exit", resolve));
      anew.disconnect();
      bnew.disconnect();
      await boot();
      const after = (
        await db.query("SELECT state FROM bx_rooms WHERE room_code=$1", [code])
      ).rows[0].state;
      if (after.phase === "round_result") {
        assert.equal(after.resultDeadline, closed.resultDeadline);
        assert.equal(after.roundId, closed.roundId);
      } else {
        // Slow startup must consume the original countdown, not grant another 10s.
        assert.equal(after.phase, "playing");
        assert.equal(after.roundNumber, closed.roundNumber + 1);
        assert.notEqual(after.roundId, closed.roundId);
        assert.equal(after.resultDeadline, null);
        assert.equal(
          after.turnEndsAt,
          closed.resultDeadline + closed.turnSeconds * 1000,
        );
        assert.ok(after.updatedAt >= closed.resultDeadline);
      }
      assert.deepEqual(after.hands, closed.hands);
      assert.equal(after.completedRounds, closed.completedRounds);
    } finally {
      for (const s of sockets) s.disconnect();
      if (child && child.exitCode === null) {
        child.kill("SIGKILL");
        await new Promise((resolve) => child.once("exit", resolve));
      }
      if (code) await db.query("DELETE FROM bx_rooms WHERE room_code=$1", [code]);
      await db.end();
    }
  },
);
