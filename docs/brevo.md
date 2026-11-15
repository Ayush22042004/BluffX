# Brevo HTTPS email setup

BluffX supports Brevo's transactional email HTTPS API from the Render backend. Vercel hosts the frontend; it does not need an email API key. Verification, password resets, account deletion confirmations and optional manual report notifications all reuse the shared backend mailer. No SMTP connection is used in Brevo mode.

## Set up the sender

1. Create an account at https://www.brevo.com and complete its onboarding/account activation requirements.
2. In Settings → Senders, Domains, IPs → Senders, add a sender named **BluffX** using an email address you control. Enter the verification code sent to that inbox. Follow [Brevo's sender instructions](https://help.brevo.com/hc/en-us/articles/208836149-Create-a-new-sender-From-name-and-From-email).
3. Create a **Brevo API key**, not an SMTP password/key. Keep it private.

You do not have to deploy first. Brevo documents temporary sender-address replacement with its own `brevosend.com` infrastructure for unauthenticated/free-email senders. This does not let you authenticate a Gmail or Vercel domain, guarantee delivery, or bypass account review. Recipients may see a Brevo-managed address. An owned authenticated sending domain is still the recommended public-release setup. See [Brevo's domain/sender guidance](https://help.brevo.com/hc/en-us/articles/16045394674066-Troubleshooting-Domain-authentication).

## Configure and test locally

Edit the existing ignored `server/.env`, not `.env.example`:

```dotenv
MAIL_PROVIDER=local
BREVO_API_KEY=your_private_brevo_api_key
MAIL_FROM=BluffX <your_verified_sender_email>
REPORTS_TO=your_own_report_inbox
APP_ORIGIN=http://localhost:5173
```

Check without sending:

```powershell
npm run check:email -- --provider brevo
```

Send exactly one test to your configured `REPORTS_TO`:

```powershell
npm run check:email -- --provider brevo --send-test
```

This explicitly tests Brevo while regular app mail remains local. Check your inbox/spam folder and the transactional logs. API acceptance alone is not proof of delivery. After receiving the test, set `MAIL_PROVIDER=brevo` and restart the backend.

If a higher-precedence root `.env.local`, root `.env` or hosting/process variable already defines a mail setting, update the effective value there. Do not overwrite unrelated database, Google or TURN settings. `auto` now prefers Brevo when its key is present, followed by Resend, SMTP and the development-only local outbox; use an explicit provider to avoid ambiguity.

## Render and Vercel

Configure these **only on the Render backend** when releasing this code:

```dotenv
MAIL_PROVIDER=brevo
BREVO_API_KEY=your_private_brevo_api_key
MAIL_FROM=BluffX <your_verified_sender_email>
REPORTS_TO=your_own_report_inbox
APP_ORIGIN=https://your_actual_frontend.vercel.app
```

Keep the existing `NODE_ENV`, `CLIENT_ORIGIN`, database, session and voice settings. Never add `BREVO_API_KEY` as a `VITE_` variable or put it in Vercel client code. Local `.env` edits do not update Render. The checked-in Render blueprint now selects Brevo, but no live environment or deployment was changed automatically.

Use the intended frontend origin in `APP_ORIGIN` so account links open the right site. Brevo account approval, sender verification, quotas and delivery restrictions must be resolved in the provider dashboard. A provider receiving a message successfully is different from an inbox receiving it.

## Durable report notifications

Existing report storage, recipient privacy, bounded queue and daily notification cap remain in place. New queue payloads record their delivery provider. Frozen recipients/senders are retained; old Resend jobs are not automatically resent through Brevo. A changed provider marks the affected job unconfirmed with `PROVIDER_CHANGED`; the stored report remains available to operators.

Brevo's [documented idempotency window](https://developers.brevo.com/docs/heterogenous-versions-batch-emails) is 30 minutes. The adapter derives stable UUID keys for report retries; the worker conservatively stops automatic retries after 25 minutes from its first attempt, retaining `RETRY_WINDOW_EXPIRED` for uncertain delivery. This prevents a restart after a long outage from resending beyond that protection. Three attempts and existing pacing/caps still apply. SMTP has no equivalent guarantee, so uncertain SMTP jobs are not automatically retried. Existing Resend protection remains available.

Before switching providers/accounts, review pending report jobs. Older paused messages need deliberate operator review; this change does not bulk resend old reports or rewrite their frozen metadata. Do not change the provider account underneath an uncertain queued send.

No schema migration, contact-list sync, marketing campaign, inbound mailbox or delivery webhook was added. Fake provider responses verify code behavior; a real account test remains necessary before delivery is signed off.
