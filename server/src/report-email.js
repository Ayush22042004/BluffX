const LIMITS = Object.freeze({
  attempts: 3,
  leaseMs: 60000,
  retryWindowMs: 23 * 3600000,
  maxPending: 100,
});
function integer(value, fallback, min, max) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min || n > max)
    throw Error("Invalid report email limit.");
  return n;
}
function settings(env = process.env) {
  const to = (env.REPORTS_TO || "").trim();
  if (to && !/^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/.test(to))
    throw Error("REPORTS_TO must be one inbox address.");
  return {
    to,
    maxDaily: integer(env.REPORT_EMAIL_MAX_DAILY, 20, 1, 50),
    intervalMs: integer(env.REPORT_EMAIL_INTERVAL_MS, 60000, 60000, 3600000),
  };
}
function reportPayload(report, to, from) {
  const reporter = report.reporter;
  const contact = reporter
    ? `Player name: ${reporter.name}\nPlayer Code: ${reporter.playerCode}\nContact email: ${reporter.email} (${reporter.emailVerified ? "verified" : "unverified"})`
    : "Player name: Guest / unavailable\nPlayer Code: Unavailable\nContact email: Unavailable (not signed in)";
  return {
    to,
    from,
    subject: `[BluffX] ${report.category} report — ${report.id.slice(0, 8)}`,
    text: `A player submitted a BluffX report.\n\nReference: ${report.id}\nCategory: ${report.category}\nCreated: ${new Date(report.created_at).toISOString()}\nBuild: ${report.build}\n\n${contact}\n\nPlayer description:\n${report.description}\n\nBluffX did not attach session credentials or a private game snapshot. The description is user-submitted. Manage reports using the private operator tools.`,
  };
}
class ReportEmail {
  constructor({
    db,
    mailer,
    env = process.env,
    now = Date.now,
    isReady = () => true,
    onError = () => {},
    schedule = true,
  }) {
    this.db = db;
    this.mailer = mailer;
    this.config = settings(env);
    this.now = now;
    this.isReady = isReady;
    this.onError = onError;
    this.automatic = schedule;
    this.enabled = !!this.config.to && mailer.mode !== "unavailable";
    this.closed = false;
    this.running = null;
    this.timer = null;
    this.again = false;
  }
  async enqueue(tx, report) {
    if (
      !this.enabled ||
      report.description === "Automatic diagnostic: application error."
    )
      return false;
    await tx.run("SELECT pg_advisory_xact_lock(71638206)");
    const count = await tx.get(
      "SELECT COUNT(*) AS n FROM bx_report_mail WHERE sent_at IS NULL AND attempts<? AND (first_attempt_at IS NULL OR first_attempt_at>?)",
      LIMITS.attempts,
      this.now() - LIMITS.retryWindowMs,
    );
    if (Number(count.n) >= LIMITS.maxPending) return false;
    const payload = reportPayload(
      report,
      this.config.to,
      this.mailer.sender || "BluffX <no-reply@bluffx.local>",
    );
    payload.deliveryProvider = this.mailer.mode;
    await tx.run(
      "INSERT INTO bx_report_mail(report_id,payload,created_at,next_attempt_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING",
      report.id,
      JSON.stringify(payload),
      report.created_at,
      report.created_at,
    );
    return true;
  }
  async claim() {
    const now = this.now(),
      day = Math.floor(now / 86400000) * 86400000;
    return this.db.transaction(async (tx) => {
      await tx.run("SELECT pg_advisory_xact_lock(71638206)");
      const budget = await tx.get(
        "SELECT MAX(attempted_at) AS last_attempt,COUNT(*) FILTER(WHERE attempted_at>=?) AS used_today FROM bx_report_mail",
        day,
      );
      const row = await tx.get(
        `SELECT * FROM bx_report_mail WHERE sent_at IS NULL AND attempts<? AND (first_attempt_at IS NULL OR first_attempt_at>?) AND (attempted_at>=? OR ?<?) ORDER BY next_attempt_at,created_at,report_id LIMIT 1`,
        LIMITS.attempts,
        now - LIMITS.retryWindowMs,
        day,
        Number(budget.used_today),
        this.config.maxDaily,
      );
      if (!row) {
        const pending = await tx.get(
          "SELECT report_id FROM bx_report_mail WHERE sent_at IS NULL AND attempts<? AND (first_attempt_at IS NULL OR first_attempt_at>?) LIMIT 1",
          LIMITS.attempts,
          now - LIMITS.retryWindowMs,
        );
        return pending ? { at: day + 86400000 } : null;
      }
      const due = Math.max(
        Number(row.next_attempt_at),
        Number(row.lease_until || 0),
        budget.last_attempt === null
          ? 0
          : Number(budget.last_attempt) + this.config.intervalMs,
      );
      if (due > now) return { at: due };
      return tx.get(
        "UPDATE bx_report_mail SET attempts=attempts+1,attempted_at=?,first_attempt_at=COALESCE(first_attempt_at,?),lease_until=? WHERE report_id=? RETURNING report_id,payload,attempts,first_attempt_at",
        now,
        now,
        now + LIMITS.leaseMs,
        row.report_id,
      );
    });
  }
  arm(at) {
    if (!this.automatic || this.closed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.kick();
      },
      Math.max(0, at - this.now()),
    );
    this.timer.unref?.();
  }
  async step() {
    if (!this.enabled || this.closed) return;
    if (!this.isReady()) {
      this.arm(this.now() + 60000);
      return;
    }
    const claim = await this.claim();
    if (!claim) return;
    if (claim.at) {
      this.arm(claim.at);
      return;
    }
    // Do not carry uncertain sends across providers or beyond their dedupe window.
    const { deliveryProvider, ...message } = claim.payload;
    const providerChanged = deliveryProvider
      ? deliveryProvider !== this.mailer.mode
      : ["brevo", "gmail"].includes(this.mailer.mode);
    const retryExpired =
      claim.attempts > 1 &&
      this.now() - Number(claim.first_attempt_at) >=
        (this.mailer.idempotencyWindowMs ?? LIMITS.retryWindowMs);
    if (providerChanged || retryExpired) {
      await this.db.run(
        "UPDATE bx_report_mail SET attempts=?,lease_until=NULL,last_error=? WHERE report_id=?",
        LIMITS.attempts,
        providerChanged ? "PROVIDER_CHANGED" : "RETRY_WINDOW_EXPIRED",
        claim.report_id,
      );
      this.arm(this.now() + this.config.intervalMs);
      return;
    }
    try {
      const result = await this.mailer.send(message, {
        idempotencyKey: "bluffx-report-" + claim.report_id,
        from: claim.payload.from,
      });
      await this.db.run(
        "UPDATE bx_report_mail SET sent_at=?,provider_id=?,lease_until=NULL,last_error=NULL WHERE report_id=?",
        this.now(),
        result.local
          ? "local-preview"
          : String(result.id || "accepted").slice(0, 128),
        claim.report_id,
      );
    } catch (e) {
      await this.db.run(
        "UPDATE bx_report_mail SET lease_until=NULL,next_attempt_at=?,last_error=? WHERE report_id=?",
        this.now() + 60000 * 5 ** (claim.attempts - 1),
        Number.isInteger(e.providerStatus)
          ? "PROVIDER_HTTP_" + e.providerStatus
          : "DELIVERY_UNCONFIRMED",
        claim.report_id,
      );
      this.onError("REPORT_EMAIL_UNCONFIRMED");
    }
    this.arm(this.now() + this.config.intervalMs);
  }
  kick() {
    if (this.closed || !this.enabled) return;
    if (this.running) {
      this.again = true;
      return;
    }
    clearTimeout(this.timer);
    this.timer = null;
    this.running = this.step()
      .catch(() => {
        this.onError("REPORT_EMAIL_STORAGE_UNAVAILABLE");
        this.arm(this.now() + 60000);
      })
      .finally(() => {
        this.running = null;
        if (this.again) {
          this.again = false;
          this.kick();
        }
      });
  }
  async close() {
    this.closed = true;
    clearTimeout(this.timer);
    await this.running;
  }
}
module.exports = { ReportEmail, settings, reportPayload, LIMITS };
