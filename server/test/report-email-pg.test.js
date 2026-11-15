const test = require("node:test"),
  assert = require("node:assert/strict"),
  crypto = require("node:crypto");
const { createGameStore } = require("../src/game-store");
const { createDatabase } = require("../src/database");
const { createMailer } = require("../src/mailer");
const { ReportEmail, LIMITS } = require("../src/report-email");
const URL = process.env.TEST_DATABASE_URL;
test(
  "real PostgreSQL report outbox: rollback, pacing, restart, bounded retry and provider idempotency",
  { skip: !URL, timeout: 180000 },
  async (t) => {
    const store = await createGameStore({
        connectionString: URL,
        directUrl: URL,
        autoMigrate: true,
      }),
      db = await createDatabase({ pool: store.pool });
    const ids = [];
    let now = Date.UTC(2030, 0, 1),
      requests = [],
      fail = false;
    const physical = new Map();
    const mailer = createMailer({
      env: {
        MAIL_PROVIDER: "resend",
        MAIL_FROM: "BluffX <original@example.com>",
        RESEND_API_KEY: "test-only-key",
      },
      fetchImpl: async (url, options) => {
        requests.push(options);
        if (fail) throw Error("private provider failure");
        const key = options.headers["Idempotency-Key"];
        if (!physical.has(key)) physical.set(key, JSON.parse(options.body));
        return { ok: true, json: async () => ({ id: "provider-" + key }) };
      },
    });
    const make = (extra = {}) =>
      new ReportEmail({
        db,
        mailer,
        env: { REPORTS_TO: "owner@example.com" },
        now: () => now,
        schedule: false,
        ...extra,
      });
    const insert = async (
      queue,
      description = "The table needs a clearer turn label.",
      rollback = false,
    ) => {
      const id = crypto.randomUUID();
      ids.push(id);
      const r = {
        id,
        category: "gameplay",
        description,
        build: "test-build",
        created_at: now,
        to: "attacker@example.com",
        hands: ["SECRET"],
      };
      await db.transaction(async (tx) => {
        await tx.run(
          "INSERT INTO bx_reports(id,category,description,build,diagnostic,created_at) VALUES(?,?,?,?,?,?)",
          id,
          r.category,
          r.description,
          r.build,
          "{}",
          now,
        );
        await queue.enqueue(tx, r);
        if (rollback) throw Error("rollback fixture");
      });
      return id;
    };
    try {
      await t.test(
        "report and queued mail roll back together; automatic diagnostics never enqueue",
        async () => {
          const q = make();
          await assert.rejects(insert(q, "A rollback test report.", true));
          assert.equal(
            await db.get(
              "SELECT report_id FROM bx_report_mail WHERE report_id=?",
              ids[0],
            ),
            undefined,
          );
          assert.equal(
            await db.get("SELECT id FROM bx_reports WHERE id=?", ids[0]),
            undefined,
          );
          const auto = await insert(
            q,
            "Automatic diagnostic: application error.",
          );
          assert.equal(
            await db.get(
              "SELECT report_id FROM bx_report_mail WHERE report_id=?",
              auto,
            ),
            undefined,
          );
        },
      );
      await t.test(
        "simultaneous workers send a committed report once to the configured inbox",
        async () => {
          now += 86400000;
          const a = make(),
            b = make(),
            id = await insert(a);
          await Promise.all([a.step(), b.step()]);
          assert.equal(requests.length, 1);
          assert.equal(physical.size, 1);
          const body = JSON.parse(requests[0].body);
          assert.deepEqual(body.to, ["owner@example.com"]);
          assert.doesNotMatch(JSON.stringify(body), /SECRET|attacker/);
          assert.equal(
            requests[0].headers["Idempotency-Key"],
            "bluffx-report-" + id,
          );
          assert.equal(
            Number(
              (
                await db.get(
                  "SELECT sent_at FROM bx_report_mail WHERE report_id=?",
                  id,
                )
              ).sent_at,
            ),
            now,
          );
        },
      );
      await t.test(
        "a failed send survives worker restart and preserves the frozen payload and sender",
        async () => {
          now += 86400000;
          const q = make(),
            id = await insert(q);
          fail = true;
          await q.step();
          fail = false;
          const failed = await db.get(
            "SELECT * FROM bx_report_mail WHERE report_id=?",
            id,
          );
          assert.equal(failed.attempts, 1);
          assert.equal(failed.last_error, "DELIVERY_UNCONFIRMED");
          now += 60000;
          const restarted = make({
            env: { REPORTS_TO: "changed@example.com" },
          });
          await restarted.step();
          const last = JSON.parse(requests.at(-1).body);
          assert.deepEqual(last.to, ["owner@example.com"]);
          assert.equal(last.from, "BluffX <original@example.com>");
          assert.equal(
            (
              await db.get(
                "SELECT attempts FROM bx_report_mail WHERE report_id=?",
                id,
              )
            ).attempts,
            2,
          );
        },
      );
      await t.test(
        "provider acceptance followed by a DB failure retries the same delivery key",
        async () => {
          now += 86400000;
          let outage = true;
          const wrapped = {
            ...db,
            run: async (sql, ...args) => {
              if (
                outage &&
                sql.startsWith("UPDATE bx_report_mail SET sent_at")
              ) {
                outage = false;
                throw Error("storage outage");
              }
              return db.run(sql, ...args);
            },
          };
          const q = make({ db: wrapped }),
            id = await insert(q),
            before = physical.size;
          await q.step();
          assert.equal(physical.size, before + 1);
          now += 60000;
          await make().step();
          assert.equal(physical.size, before + 1);
          assert.ok(
            (
              await db.get(
                "SELECT sent_at FROM bx_report_mail WHERE report_id=?",
                id,
              )
            ).sent_at,
          );
        },
      );
      await t.test(
        "daily cap defers extra reports without losing them",
        async () => {
          now += 86400000;
          const q = make({
            env: {
              REPORTS_TO: "owner@example.com",
              REPORT_EMAIL_MAX_DAILY: "1",
            },
          });
          await insert(q);
          const second = await insert(q);
          await q.step();
          now += 60000;
          const plan = await q.claim();
          assert.equal(
            plan.at,
            Math.floor(now / 86400000) * 86400000 + 86400000,
          );
          now = plan.at;
          await q.step();
          assert.ok(
            (
              await db.get(
                "SELECT sent_at FROM bx_report_mail WHERE report_id=?",
                second,
              )
            ).sent_at,
          );
        },
      );
      await t.test(
        "retry count and the provider idempotency window are bounded",
        async () => {
          now += 86400000;
          let q = make(),
            id = await insert(q);
          fail = true;
          for (let i = 0; i < 3; i++) {
            await q.step();
            now += 60000 * 5 ** i;
          }
          const count = requests.length;
          await q.step();
          assert.equal(requests.length, count);
          assert.equal(
            (
              await db.get(
                "SELECT attempts FROM bx_report_mail WHERE report_id=?",
                id,
              )
            ).attempts,
            3,
          );
          now += 86400000;
          id = await insert(q);
          await q.step();
          fail = false;
          now += LIMITS.retryWindowMs + 1;
          const before = requests.length;
          await make().step();
          assert.equal(requests.length, before);
        },
      );
      await t.test(
        "an empty eligible queue does not leave an idle polling timer",
        async () => {
          const q = make({ schedule: true });
          q.kick();
          await q.running;
          assert.equal(q.timer, null);
          await q.close();
        },
      );
      await t.test(
        "Brevo retries stay within its provider window and old-provider jobs cannot cross over",
        async () => {
          now += 86400000;
          let sends = 0,
            offline = true;
          const brevo = createMailer({
            env: {
              MAIL_PROVIDER: "brevo",
              BREVO_API_KEY: "private-brevo-test",
              MAIL_FROM: "BluffX <owner@example.com>",
            },
            fetchImpl: async () => {
              sends++;
              if (offline) throw Error("network");
              return {
                ok: true,
                json: async () => ({ messageId: "brevo-accepted" }),
              };
            },
          });
          let q = make({ mailer: brevo }),
            id = await insert(q);
          await q.step();
          assert.equal(sends, 1);
          now += 26 * 60000;
          await make({ mailer: brevo }).step();
          assert.equal(sends, 1);
          assert.equal(
            (
              await db.get(
                "SELECT last_error FROM bx_report_mail WHERE report_id=?",
                id,
              )
            ).last_error,
            "RETRY_WINDOW_EXPIRED",
          );
          now += 86400000;
          q = make();
          id = await insert(q);
          await make({ mailer: brevo }).step();
          assert.equal(sends, 1);
          assert.equal(
            (
              await db.get(
                "SELECT last_error FROM bx_report_mail WHERE report_id=?",
                id,
              )
            ).last_error,
            "PROVIDER_CHANGED",
          );
          now += 86400000;
          offline = false;
          q = make({ mailer: brevo });
          id = await insert(q);
          await q.step();
          assert.equal(sends, 2);
          assert.equal(
            (
              await db.get(
                "SELECT provider_id FROM bx_report_mail WHERE report_id=?",
                id,
              )
            ).provider_id,
            "brevo-accepted",
          );
        },
      );
      await t.test(
        "private operator status exposes delivery state without inbox payloads",
        async () => {
          const express = require("express"),
            { installLaunch } = require("../src/launch-controls");
          const app = express(),
            previous = process.env.OPS_API_TOKEN,
            secret = "isolated-operator-test-secret-1234567890";
          process.env.OPS_API_TOKEN = secret;
          installLaunch({
            app,
            auth: { database: db },
            service: { rooms: new Map() },
            io: { sockets: { sockets: new Map() } },
            metrics: { report: () => ({}) },
            build: "test",
          });
          const server = await new Promise((r) => {
            const s = app.listen(0, () => r(s));
          });
          try {
            const url =
              "http://localhost:" + server.address().port + "/auth/ops/reports";
            assert.equal((await fetch(url)).status, 403);
            const r = await fetch(url, {
              headers: { authorization: "Bearer " + secret },
            });
            assert.equal(r.status, 200);
            const reports = (await r.json()).reports;
            assert.equal(
              reports.find((x) => x.id === ids[2]).email_status,
              "provider_accepted",
            );
            assert.ok(!JSON.stringify(reports).includes("owner@example.com"));
            assert.ok(!JSON.stringify(reports).includes("test-only-key"));
          } finally {
            await new Promise((r) => server.close(r));
            if (previous === undefined) delete process.env.OPS_API_TOKEN;
            else process.env.OPS_API_TOKEN = previous;
          }
        },
      );
    } finally {
      fail = false;
      await store.pool.query(
        "DELETE FROM bx_reports WHERE id=ANY($1::text[])",
        [ids],
      );
      await db.close();
      await store.close();
    }
  },
);
