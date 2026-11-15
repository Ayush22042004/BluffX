# Resend setup: account emails and player reports

Deployment is not required to configure or test Resend. Without a domain, Resend's `onboarding@resend.dev` sender can send only to the email address associated with your Resend account. Public verification/reset emails require an owned, verified sending domain. See [Resend's test-sender restriction](https://resend.com/docs/knowledge-base/403-error-resend-dev-domain).

## Start without a domain

1. Create an account at https://resend.com and create an API key with sending access.
2. Edit the existing ignored `server/.env`; never commit the key:

```dotenv
MAIL_PROVIDER=local
RESEND_API_KEY=re_replace_with_your_key
MAIL_FROM=BluffX <onboarding@resend.dev>
REPORTS_TO=your_resend_account_email@example.com
REPORT_EMAIL_MAX_DAILY=20
REPORT_EMAIL_INTERVAL_MS=60000
APP_ORIGIN=http://localhost:5173
```

3. Run `npm run check:email`. This checks configuration without sending anything or printing the key/inbox.
4. Run `npm run check:email -- --send-test` to send one test to `REPORTS_TO`. This explicitly tests Resend even while `MAIL_PROVIDER=local`. Check the inbox/spam folder: API acceptance alone does not prove delivery.
5. After receiving the test, set `MAIL_PROVIDER=resend` and restart the backend. Account emails to other addresses still cannot work with the test sender. Keep local previews instead if testing other accounts without a verified domain.

Hosting/process variables take precedence over root `.env.local`, root `.env`, then `server/.env`. Remove conflicting older values at the higher-precedence location. Editing `.env.example` does not configure the running app.

## Production sender

Add a domain you own to Resend and copy its exact DNS records into your DNS provider. Fix failed DKIM records and wait for verification. Your website does not have to be deployed for DNS verification. Follow [Resend domain setup](https://resend.com/docs/dashboard/domains/introduction).

Configure the Render backend with `MAIL_PROVIDER=resend`, its private `RESEND_API_KEY`, `MAIL_FROM=BluffX <support@your-verified-domain.example>`, and your private `REPORTS_TO` inbox. Set `APP_ORIGIN` to the stable Vercel frontend URL so account links open the right site. Keep existing database, authentication, CORS and voice settings. Never put these mail secrets in `VITE_` variables or frontend code.

Before releasing this code, review and apply pending additive migrations through `006_report_email.sql` during the existing single-instance maintenance handoff. No production migration or deployment is performed by this setup work. See [deployment instructions](deployment.md).

## What is connected

Verification, password reset and account deletion confirmation already use the shared mailer. Manual player reports now optionally enqueue a support notification atomically with the stored report. Automatic browser diagnostics remain in the private report list without sending email. Friend requests and gameplay do not generate mail.

Reports remain the source of truth in PostgreSQL. Empty `REPORTS_TO` disables notifications. Local mode writes private mail previews and marks those notifications `local_preview`; switching to Resend does not resend previews or backfill old reports.

Notifications contain the report reference, category, build, timestamp and user-submitted description. No private game snapshot or session credential is attached. Players should not put sensitive information in their description. Recipients and senders come from backend configuration, never report payloads.

The durable queue defaults to 20 distinct report notifications per UTC day, at least 60 seconds between attempts, up to 100 pending items, and three attempts within 23 hours of the first attempt. Stable payloads and Resend idempotency keys protect retries within its [24-hour idempotency window](https://resend.com/changelog/idempotency-keys). Overflow, exhausted and unconfigured notifications leave the underlying report available in the operator tools. This cap covers reports only, not authentication emails.

The private operator report endpoint shows `not_queued`, `pending`, `local_preview`, `provider_accepted`, or `unconfirmed`, attempt counts and safe errors. Provider acceptance is not proof of inbox delivery. Bounce webhooks, inbound support mail and automated replies are not implemented. A verified sending domain does not itself create a receiving mailbox.

An idle empty queue has no polling interval. Delivery failure does not delete a report; queue persistence failure rejects the submission safely. Retention/deletion of a report cascades to its notification row. Queued recipients and payloads are frozen: changing configuration does not rewrite existing queued mail.
