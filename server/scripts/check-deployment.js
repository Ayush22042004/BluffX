// Read-only live checks by default; authenticated checks require an isolated local environment.
require("../src/environment").loadEnvironment();
const { Pool } = require("../node_modules/pg");
const { verifiedConnectionString } = require("../src/database");
const crypto = require("node:crypto");
const { promisify } = require("node:util");
// Default checks are strictly read-only. Never create a production account/game.
if (process.env.DEPLOYMENT_CHECK_MODE !== "isolated") {
  (async () => {
    const frontend =
      process.env.DEPLOYMENT_FRONTEND_URL || "https://bluffx.vercel.app";
    const backend =
      process.env.DEPLOYMENT_BACKEND_URL || "https://bluffx.onrender.com";
    const get = async (url) => {
      const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (!r.ok)
        throw Error("HTTP " + r.status + " at " + new URL(url).pathname);
      return r;
    };
    const health = await (await get(backend + "/health")).json();
    if (!health.ok) throw Error("Backend not ready");
    // /health is process liveness. /ready is cached readiness and never probes SQL.
    const readiness = await (await get(backend + "/ready")).json();
    if (!readiness.ready) throw Error("Backend storage recovery is not ready");
    console.log(
      "PASS read-only backend health; deployed version:",
      health.version || "unreported",
    );
    const expected = process.env.DEPLOYMENT_EXPECTED_VERSION;
    const expectedRevision = process.env.DEPLOYMENT_EXPECTED_REVISION;
    if (expected && health.version !== expected)
      throw Error("Backend version mismatch; expected " + expected);
    if (expectedRevision && !health.build?.endsWith(":" + expectedRevision))
      throw Error("Backend revision mismatch; expected " + expectedRevision);
    await get(frontend);
    console.log("PASS frontend availability");
    if (expected || expectedRevision) {
      const version = await (await get(frontend + "/version.json")).json();
      if (expected && version.version !== expected) throw Error("Frontend version mismatch; expected " + expected);
      if (expectedRevision && version.revision !== expectedRevision)
        throw Error("Frontend revision mismatch; expected " + expectedRevision);
      console.log("PASS matching frontend/backend release versions");
    }
    await get(frontend + "/auth/config");
    await get(frontend + "/auth/session");
    console.log("PASS same-origin authentication proxy endpoints");
    console.log(
      "Read-only checks complete. No account, session or match created. Authenticated beta.2 flows are tested on isolated ports 4020/5180.",
    );
  })().catch((e) => {
    console.error("Read-only deployment check failed:", e.message);
    process.exitCode = 1;
  });
} else {
  const frontend = process.env.DEPLOYMENT_FRONTEND_URL;
  if (
    !frontend ||
    !["localhost", "127.0.0.1"].includes(new URL(frontend).hostname)
  )
    throw Error("Authenticated checks require an isolated local frontend.");
  require("../test/real-db-env.cjs");
  const {
    chromium,
    expect,
  } = require("../../client/node_modules/@playwright/test");
  (async () => {
    const pool = new Pool({
      connectionString: verifiedConnectionString(process.env.DATABASE_URL),
      connectionTimeoutMillis: 15000,
    });
    const id = crypto.randomUUID(),
      email = `deployment-check-${id}@example.com`,
      password = crypto.randomBytes(20).toString("hex");
    const salt = crypto.randomBytes(16).toString("hex");
    const hash =
      salt +
      ":" +
      (await promisify(crypto.scrypt)(password, salt, 64)).toString("hex");
    let browser,
      stage = "create temporary verified account";
    try {
      await pool.query(
        "INSERT INTO users(id,email,name,avatar,password_hash,email_verified,created_at,tutorial_status) VALUES($1,$2,$3,0,$4,1,$5,'completed')",
        [id, email, "Deploy Check", hash, Date.now()],
      );
      browser = await chromium.launch({ channel: "chrome", headless: true });
      const page = await browser.newPage();
      {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Network.enable");
        await cdp.send("Network.setCookieControls", {
          enableThirdPartyCookieRestriction: true,
          disableThirdPartyCookieMetadata: true,
          disableThirdPartyCookieHeuristics: true,
        });
        cdp.on("Network.responseReceivedExtraInfo", (event) => {
          if (event.blockedCookies?.length)
            console.log(
              "Cookie blocked:",
              event.blockedCookies.map((c) => c.blockedReasons),
            );
        });
      }
      page.setDefaultTimeout(45000);
      const api = [];
      let googleOriginError = false;
      page.on("response", (r) => {
        if (new URL(r.url()).pathname.startsWith("/auth/"))
          api.push({ path: new URL(r.url()).pathname, status: r.status() });
      });
      page.on("console", (m) => {
        if (m.text().includes("origin is not allowed"))
          googleOriginError = true;
      });
      stage = "load frontend and backend configuration";
      const response = await page.goto(frontend, {
        waitUntil: "domcontentloaded",
      });
      if (response.status() !== 200) throw Error("Frontend unavailable");
      await page.getByLabel("Email address", { exact: true }).fill(email);
      await page.getByLabel("Password", { exact: true }).fill(password);
      stage = "browser sign-in across Vercel and Render";
      await page
        .locator("form")
        .getByRole("button", { name: "Sign In", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: /You \(Deploy Check\)/ }),
      ).toBeVisible();
      console.log("PASS production browser sign-in");
      stage = "restore secure session after reload";
      await page.reload();
      await expect(
        page.getByRole("button", { name: /You \(Deploy Check\)/ }),
      ).toBeVisible();
      console.log(
        "PASS production session persists after reload with third-party cookies blocked",
      );
      const sessionCookie = (await page.context().cookies()).find(
        (c) => c.name === "bluffx_session",
      );
      expect(sessionCookie?.domain).toBe(new URL(frontend).hostname);
      expect(sessionCookie?.httpOnly).toBe(true);
      expect(sessionCookie?.secure).toBe(frontend.startsWith("https:"));
      stage = "authenticated websocket and AI table";
      await page
        .getByRole("button", { name: "Play with AI", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Create AI Table", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "Pre-Game Lobby" }),
      ).toBeVisible();
      await expect(page.locator(".lobby-self")).toContainText("Deploy Check");
      await page
        .getByRole("button", { name: "Start Match", exact: true })
        .click();
      await expect(page.locator(".hand .card").first()).toBeVisible();
      console.log("PASS production authenticated game table and dealt cards");
      console.log(JSON.stringify({ authRequests: api, googleOriginError }));
    } catch (error) {
      console.error("FAIL", stage, error.name);
      if (browser) {
        const pages = browser.contexts().flatMap((c) => c.pages());
        const p = pages[0];
        if (p) {
          console.log(
            "Visible alert:",
            await p
              .getByRole("alert")
              .allTextContents()
              .catch(() => []),
          );
          console.log(
            "Session cookies:",
            (await p.context().cookies()).map((c) => ({
              domain: c.domain,
              sameSite: c.sameSite,
              secure: c.secure,
            })),
          );
        }
      }
      process.exitCode = 1;
    } finally {
      await browser?.close();
      await pool.query("DELETE FROM users WHERE id=$1", [id]);
      await pool.end();
      console.log(
        "Temporary production test account removed. No email was sent.",
      );
    }
  })().catch((e) => {
    console.error(e.code || e.name);
    process.exitCode = 1;
  });
}
