require("../src/environment").loadEnvironment();
const { createMailer } = require("../src/mailer");
const { settings } = require("../src/report-email");
(async () => {
  const config = settings(),
    send = process.argv.includes("--send-test");
  const configured = createMailer();
  const index = process.argv.indexOf("--provider");
  const provider =
    index >= 0
      ? process.argv[index + 1]
      : ["gmail", "brevo", "resend"].includes(configured.mode)
        ? configured.mode
        : "gmail";
  if (!["gmail", "brevo", "resend"].includes(provider))
    throw Error("Use --provider gmail, --provider brevo or --provider resend.");
  console.log(
    "Gmail OAuth client: " +
      (process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET
        ? "configured"
        : "missing"),
  );
  console.log(
    "Brevo API key: " + (process.env.BREVO_API_KEY ? "configured" : "missing"),
  );
  console.log(
    "Resend API key: " +
      (process.env.RESEND_API_KEY ? "configured" : "missing"),
  );
  console.log("Sender: " + (process.env.MAIL_FROM ? "configured" : "missing"));
  console.log("Report inbox: " + (config.to ? "configured" : "missing"));
  const mailer = createMailer({
    env: { ...process.env, MAIL_PROVIDER: provider },
  });
  console.log("App mail mode: " + configured.mode);
  console.log("Checked provider: " + provider + " (" + mailer.mode + ")");
  if (process.argv.includes("--check-auth")) {
    if (!mailer.checkAuthorization)
      throw Error("Authorization-only checks require a configured Gmail provider.");
    await mailer.checkAuthorization();
    console.log("PASS Gmail sender authorization is valid. No email was sent.");
  }
  if (!send) {
    console.log(
      "Configuration check only. No email sent. Use --send-test explicitly for one real HTTPS email test to REPORTS_TO; select --provider gmail, --provider brevo or --provider resend.",
    );
    return;
  }
  if (!config.to)
    throw Error("Set REPORTS_TO to your own inbox before testing.");
  const result = await mailer.send({
    to: config.to,
    subject: "BluffX email setup test",
    text: "This is your requested BluffX email provider setup test. If you received this, the selected provider accepted the configured sender and inbox. Account email links use APP_ORIGIN; player reports will include their reference and submitted description. No player data or credentials are included in this test.",
  });
  console.log(
    "PASS The provider accepted the test email. Check your inbox/spam folder; API acceptance alone does not prove inbox delivery.",
  );
  if (result.id) console.log("Provider message ID: " + result.id);
})().catch((e) => {
  console.error(
    "Email check failed: " +
      (e.providerStatus
        ? "provider HTTP " + e.providerStatus
        : e.code || e.message),
  );
  console.error(
    "Check the selected provider API key, sender authorization and account activation. No secret values were printed.",
  );
  if (e.providerReason) console.error("Gmail OAuth reason: " + e.providerReason);
  if (e.providerReason === "invalid_grant")
    console.error("The refresh token expired or was revoked. Check Google Auth Platform publishing status, reauthorize the sender, and replace GMAIL_REFRESH_TOKEN in Render. External Testing-mode Gmail grants expire after seven days.");
  process.exitCode = 1;
});
