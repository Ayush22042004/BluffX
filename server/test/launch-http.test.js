const test = require("node:test"),
  assert = require("node:assert/strict"),
  express = require("express");
const { newDb } = require("pg-mem");
const { createAuth } = require("../src/auth");
const { installLaunch } = require("../src/launch-controls");
test("reports are sanitized and private; email-confirmed deletion revokes sessions and retries durable erasure", async () => {
  const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg(),
    pool = new Pool(),
    mail = [];
  let failErasure = true,
    erased = [];
  const auth = await createAuth({
    pool,
    production: false,
    allowedOrigins: new Set(["http://localhost:5180"]),
    mailer: { mode: "local", send: async (m) => mail.push(m) },
    onErase: async (id) => {
      if (failErasure) throw Error("test outage");
      erased.push(id);
    },
  });
  const app = express();
  app.use("/auth", auth.router);
  installLaunch({
    app,
    auth,
    service: { rooms: new Map() },
    io: { sockets: { sockets: new Map() } },
    metrics: { add() {}, report: () => ({}) },
    build: "test-build",
  });
  const server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    }),
    base = "http://127.0.0.1:" + server.address().port;
  const call = async (path, body, cookie) => {
    const r = await fetch(base + "/auth/" + path, {
      method: body ? "POST" : "GET",
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(cookie ? { cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return {
      status: r.status,
      data: await r.json(),
      cookie: r.headers.get("set-cookie"),
    };
  };
  try {
    const account = await call("signup", {
      name: "Erase Account",
      email: "erase@example.com",
      password: "ErasePassword123!",
    });
    assert.equal(account.status, 201);
    const report = await call(
      "report",
      {
        category: "voice",
        description: "Voice stopped during a test.",
        roomId: "FORGED",
        matchId: "FORGED",
        hands: ["SECRET_CARD"],
        codes: ["STALE_TURN", "private token"],
      },
      account.cookie,
    );
    assert.equal(report.status, 201);
    const row = await auth.database.get(
      "SELECT * FROM bx_reports WHERE id=?",
      report.data.id,
    );
    assert.equal(row.room_code, null);
    assert.equal(row.match_id, null);
    assert.equal(JSON.stringify(row).includes("SECRET_CARD"), false);
    assert.deepEqual(row.diagnostic.codes, ["STALE_TURN"]);
    assert.equal((await call("ops/reports")).status, 403);
    assert.equal(
      (await call("confirm-account-deletion", { token: "bad" })).status,
      400,
    );
    assert.equal(
      (await call("request-account-deletion", {}, account.cookie)).status,
      200,
    );
    const message = mail.find((m) => m.subject.includes("deletion"));
    const token = new URL(message.text.match(/http[^\s]+/)[0]).searchParams.get(
      "token",
    );
    assert.equal(
      (await call("confirm-account-deletion", { token })).status,
      200,
    );
    assert.equal((await call("session", null, account.cookie)).data.user, null);
    assert.equal(
      (
        await call("login", {
          email: "erase@example.com",
          password: "ErasePassword123!",
        })
      ).status,
      401,
    );
    assert.equal(
      (await call("confirm-account-deletion", { token })).status,
      400,
    );
    assert.equal(
      Number(
        (await auth.database.get("SELECT COUNT(*) AS n FROM account_erasure"))
          .n,
      ),
      1,
    );
    await auth.close();
    failErasure = false;
    const restarted = await createAuth({
      pool,
      production: false,
      mailer: { mode: "local", send: async () => {} },
      onErase: async (id) => erased.push(id),
    });
    assert.equal(erased.length, 1);
    assert.equal(
      Number(
        (await restarted.database.get("SELECT COUNT(*) AS n FROM users")).n,
      ),
      0,
    );
    assert.equal(
      Number(
        (
          await restarted.database.get(
            "SELECT COUNT(*) AS n FROM account_erasure",
          )
        ).n,
      ),
      0,
    );
    await restarted.close();
  } finally {
    await auth.close();
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }
});
