const test = require("node:test"),
  assert = require("node:assert/strict");
const { ReportEmail, settings, reportPayload } = require("../src/report-email");
test("report email settings are bounded and reject client-style recipient lists", () => {
  assert.equal(settings({}).to, "");
  assert.equal(settings({}).maxDaily, 20);
  for (const env of [
    { REPORTS_TO: "a@example.com,b@example.com" },
    { REPORTS_TO: "bad" },
    { REPORT_EMAIL_MAX_DAILY: 1000 },
    { REPORT_EMAIL_INTERVAL_MS: 1 },
  ])
    assert.throws(() => settings(env));
});
test("report notifications use the configured recipient and omit forged/private context", () => {
  const m = reportPayload(
    {
      id: "reference",
      category: "gameplay",
      created_at: 1,
      description: "My report text",
      build: "test",
      codes: ["SOCKET_PING_TIMEOUT", "private\nsecret"],
      to: "attacker@example.com",
      hands: ["SECRET"],
      token: "PRIVATE",
    },
    "owner@example.com",
    "BluffX <sender@example.com>",
  );
  assert.equal(m.to, "owner@example.com");
  assert.match(m.text, /My report text/);
  assert.match(m.text, /Connection diagnostics \(client-reported\): SOCKET_PING_TIMEOUT/);
  assert.doesNotMatch(m.text, /private\nsecret/);
  assert.match(m.text, /Contact email: Unavailable/);
  assert.doesNotMatch(JSON.stringify(m), /SECRET|PRIVATE|attacker/);
});
test("report email includes private account contact details and verification status", () => {
  const report = { id: "reference", category: "gameplay", created_at: 1,
    build: "test", description: "Test report", reporter: {
      name: "Player One", playerCode: "ABCD-1234-EFAB-5678",
      email: "player@example.com", emailVerified: true,
    } };
  const m = reportPayload(report, "support@example.com", "sender@example.com");
  assert.match(m.text, /Player name: Player One/);
  assert.match(m.text, /Player Code: ABCD-1234-EFAB-5678/);
  assert.match(m.text, /Contact email: player@example.com \(verified\)/);
  report.reporter.emailVerified = false;
  assert.match(reportPayload(report, "support@example.com").text, /\(unverified\)/);
});
test("disabled report email does not create timers or query storage", async () => {
  const q = new ReportEmail({
    db: {
      transaction() {
        throw Error("must not query");
      },
    },
    mailer: { mode: "local" },
    env: {},
  });
  q.kick();
  await q.step();
  assert.equal(q.timer, null);
  await q.close();
  const unavailable = new ReportEmail({
    db: {},
    mailer: { mode: "unavailable" },
    env: { REPORTS_TO: "owner@example.com" },
  });
  assert.equal(unavailable.enabled, false);
});
