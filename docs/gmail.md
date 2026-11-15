# Send BluffX email from an existing Gmail mailbox

This provider uses the Gmail REST API over HTTPS from the Render backend. Gmail authenticates mail sent from your existing Gmail/Workspace mailbox, so you do not need to own a custom sending domain or open SMTP ports. Vercel remains the frontend. No Gmail password or app password is used.

Account verification, password reset, deletion confirmation and optional report notifications reuse the shared mailer. Only the sender account owner grants Google authorization; game players do not grant mailbox access. The helper requests `gmail.send` plus basic identity scopes to verify the authorized account. It does not request inbox read access. See [Google's sending API](https://developers.google.com/workspace/gmail/api/guides/sending) and [scope reference](https://developers.google.com/workspace/gmail/api/auth/scopes).

## 1. Configure Google once

1. In https://console.cloud.google.com/ create/select a project for **BluffX Mail**. A separate mail project avoids changing the existing player Google-sign-in client.
2. Enable **Gmail API** in APIs & Services → Library.
3. Configure Google Auth Platform branding/audience. For initial testing, add the sending Gmail address as a test user.
4. Create an OAuth client of type **Desktop app**, intended for the private local sender-authorization helper. Copy its client ID and secret into the ignored `server/.env`:

```dotenv
MAIL_PROVIDER=local
GMAIL_CLIENT_ID=your_desktop_oauth_client_id
GMAIL_CLIENT_SECRET=your_private_client_secret
GMAIL_USER=your_sender@gmail.com
MAIL_FROM=BluffX <your_sender@gmail.com>
REPORTS_TO=your_own_inbox
```

Keep `GOOGLE_CLIENT_ID` for player sign-in separate. Use your primary Gmail/Workspace mailbox in both `GMAIL_USER` and `MAIL_FROM`; this adapter does not send as arbitrary aliases. Do not put mail secrets in any `VITE_` variable.

## 2. Authorize the owner mailbox

From the project root:

```powershell
npm run gmail:authorize
```

Open the local URL it prints (`http://127.0.0.1:4055/start`), choose the configured sender account and approve sending access. The helper binds only to loopback, validates OAuth state/PKCE, verifies the signed identity and checks that it matches `GMAIL_USER`. It saves the refresh token privately in ignored `server/.data/gmail-oauth.json` and never prints it or edits your existing environment file.

The helper waits five minutes. If cancelled or timed out, rerun it; no email is sent by authorization. Do not run it on Render or expose its local callback publicly. Desktop clients support a loopback authorization flow; [Google's OAuth guidance](https://developers.google.com/identity/protocols/oauth2/native-app) describes it.

**Token lifetime:** external OAuth projects in Testing mode issue Gmail-scope refresh tokens that expire after seven days. Before relying on unattended delivery, review the audience/publishing status and verification requirements for the owner-only/service-account-use case. Google may require consent verification or Workspace administrator approval depending on configuration. Do not assume a testing token is permanent or that app publishing removes every verification requirement. Only the owner mailbox is an OAuth user in this integration; email recipients are not OAuth users. See [Google's token-expiration guidance](https://developers.google.com/identity/protocols/oauth2) and [verification exceptions](https://support.google.com/cloud/answer/13464323).

## 3. Send one setup test

```powershell
npm run check:email -- --provider gmail
npm run check:email -- --provider gmail --send-test
```

The first command checks flags without sending or printing credentials. The second explicitly sends one fixed setup message to `REPORTS_TO`, even while regular app mail remains local. Confirm receipt in the inbox/spam folder. API acceptance alone is not proof of inbox delivery.

Then set `MAIL_PROVIDER=gmail` and restart the backend. Local development can read the private token file if its client ID and sender match the current configuration. Production deliberately requires `GMAIL_REFRESH_TOKEN` in environment variables instead of relying on local disk.

## 4. Configure Render when deploying

Open the private `server/.data/gmail-oauth.json` locally and copy its `refreshToken` value into **Render → backend → Environment → GMAIL_REFRESH_TOKEN**. Do not paste it in chat, commit the file or add it to Vercel frontend variables.

```dotenv
MAIL_PROVIDER=gmail
GMAIL_CLIENT_ID=your_desktop_oauth_client_id
GMAIL_CLIENT_SECRET=your_private_client_secret
GMAIL_REFRESH_TOKEN=your_private_refresh_token
GMAIL_USER=your_sender@gmail.com
MAIL_FROM=BluffX <your_sender@gmail.com>
REPORTS_TO=your_own_report_inbox
APP_ORIGIN=https://your_actual_frontend.vercel.app
```

Keep existing database, CORS, Google player sign-in, cookie and TURN configuration. Changing local files does not configure Render. No deployment or hosted environment change is performed automatically.

## Reliability and limits

- Access tokens are cached in memory and concurrent sends share one refresh request. No token is stored in public state or database/game snapshots.
- Sending is bounded by request timeouts. Provider errors are sanitized; revoked/expired authorization needs the owner to run authorization again and update Render's refresh token.
- This is a real mailbox with Google's account-specific sending limits, not an unlimited bulk-email service. Use a dedicated sender mailbox for the game and monitor delivery/account health.
- Gmail's send endpoint does not provide the report queue's provider-idempotency guarantee. An uncertain report send is not automatically retried, including after restart. The report remains stored and marked unconfirmed for review. Do not mistake an RFC Message-ID for duplicate prevention.
- New report jobs pin their provider. Pending Resend/Brevo jobs are not silently replayed through Gmail. Review them before switching; no bulk resend or migration is performed.
- Original Resend/Brevo/SMTP alternatives remain available, but explicit `MAIL_PROVIDER=gmail` avoids ambiguity. `auto` prefers a configured Gmail refresh token before the other providers.

Live mailbox authorization and test delivery are required before sign-off. Simulated API tests cannot prove Google's account approval or delivery into recipients' inboxes.
