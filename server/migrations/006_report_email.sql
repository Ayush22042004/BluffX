CREATE TABLE IF NOT EXISTS bx_report_mail (
  report_id TEXT PRIMARY KEY REFERENCES bx_reports(id) ON DELETE CASCADE,
  payload JSONB NOT NULL, created_at BIGINT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at BIGINT NOT NULL, first_attempt_at BIGINT,
  attempted_at BIGINT, lease_until BIGINT, sent_at BIGINT,
  provider_id TEXT, last_error TEXT
);
CREATE INDEX IF NOT EXISTS bx_report_mail_due ON bx_report_mail(next_attempt_at) WHERE sent_at IS NULL;
CREATE INDEX IF NOT EXISTS bx_report_mail_budget ON bx_report_mail(attempted_at);
REVOKE ALL ON bx_report_mail FROM PUBLIC;
