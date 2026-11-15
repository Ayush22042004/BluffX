const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { newDb } = require("pg-mem");
const { createAuth } = require("../src/auth");
async function setup(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bluffx-auth-test-"));
  const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg();
  const pool = new Pool();
  const outbox = path.join(root, "mail"),
    revoked = [];
  let auth, server, base;
  async function start() {
    const app = express();
    auth = await createAuth({
      allowedOrigins: new Set(["http://localhost:5173"]),
      pool,
      outboxPath: outbox,
      googleClientId: "test-client-id",
      googleVerifier: async (credential) => {
        if (credential === "invalid") throw Error("bad signature");
        return {
          sub: credential,
          email: `${credential}@example.com`,
          email_verified: true,
          name: "Google Player",
        };
      },
      onRevoke: (...args) => revoked.push(args),
      ...options,
    });
    app.use("/auth", auth.router);
    await new Promise((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    base = `http://127.0.0.1:${server.address().port}/auth/`;
  }
  await start();
  const request = async (route, body, cookie, method = "POST", origin) => {
    const res = await fetch(base + route, {
      method,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(cookie ? { cookie } : {}),
        ...(origin ? { origin } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return {
      status: res.status,
      body: await res.json(),
      cookie: res.headers.get("set-cookie"),
      headers: res.headers,
    };
  };
  const mails = () =>
    fs.existsSync(outbox)
      ? fs
          .readdirSync(outbox)
          .map((f) => JSON.parse(fs.readFileSync(path.join(outbox, f), "utf8")))
      : [];
  const tokenFor = (kind) => {
    const mail = mails().find((m) =>
      m.subject.includes(kind === "reset" ? "Reset" : "Verify"),
    );
    return new URL(mail.text.match(/http[^\s]+/)[0]).searchParams.get("token");
  };
  return {
    request,
    mails,
    tokenFor,
    pool,
    revoked,
    restart: async () => {
      await new Promise((r) => server.close(r));
      await auth.close();
      await start();
    },
    close: async () => {
      await new Promise((r) => server.close(r));
      await auth.close();
      await pool.end();
      if (
        path.dirname(root) === path.resolve(os.tmpdir()) &&
        path.basename(root).startsWith("bluffx-auth-test-")
      )
        fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
const data = {
  name: "Bluffer",
  email: "player@example.com",
  password: "SecretPass123!",
};
test("cross-site deployment cookies are secure and cleared consistently", async () => {
  const f = await setup({
    production: true,
    cookieSameSite: "none",
    mailer: { mode: "resend", send: async () => ({ id: "test" }) },
  });
  try {
    const signup = await f.request("signup", data);
    assert.equal(signup.status, 201);
    assert.match(signup.cookie, /HttpOnly/);
    assert.match(signup.cookie, /Secure/);
    assert.match(signup.cookie, /SameSite=None/);
    const logout = await f.request("logout", {}, signup.cookie.split(";")[0]);
    assert.match(logout.cookie, /Secure/);
    assert.match(logout.cookie, /SameSite=None/);
  } finally {
    await f.close();
  }
});
test("invalid or insecure cross-site cookie configuration fails before connecting", async () => {
  await assert.rejects(
    createAuth({ cookieSameSite: "invalid" }),
    /SESSION_COOKIE_SAME_SITE/,
  );
  await assert.rejects(
    createAuth({ cookieSameSite: "none", production: false }),
    /HTTPS/,
  );
});
test("email signup persists safe sessions and hashed passwords across server restarts", async () => {
  const f = await setup();
  try {
    const s = await f.request("signup", data);
    assert.equal(s.status, 201);
    assert.equal(s.body.user.emailVerified, false);
    assert.equal(s.body.user.password_hash, undefined);
    assert.match(s.cookie, /HttpOnly/);
    assert.match(s.cookie, /SameSite=Lax/);
    const cookie = s.cookie.split(";")[0];
    const db = f.pool;
    const user = (await db.query("SELECT * FROM users")).rows[0];
    assert.notEqual(user.password_hash, data.password);
    assert.match(user.password_hash, /^[a-f0-9]{32}:[a-f0-9]{128}$/);
    assert.notEqual(
      (await db.query("SELECT hash FROM sessions")).rows[0].hash,
      cookie.split("=")[1],
    );

    await f.restart();
    const session = await f.request("session", undefined, cookie, "GET");
    assert.equal(session.body.user.name, "Bluffer");
    const login = await f.request("login", {
      email: "PLAYER@example.com",
      password: data.password,
    });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.id, s.body.user.id);
    const wrong = await f.request("login", {
      email: data.email,
      password: "incorrect-password",
    });
    assert.equal(wrong.status, 401);
    const missing = await f.request("login", {
      email: "missing@example.com",
      password: "incorrect-password",
    });
    assert.equal(missing.body.message, wrong.body.message);
    await f.request("logout", {}, cookie);
    assert.equal(
      (await f.request("session", undefined, cookie, "GET")).body.user,
      null,
    );
  } finally {
    await f.close();
  }
});
test("verification links are single-use and local mail is written without exposing tokens in responses", async () => {
  const f = await setup();
  try {
    const s = await f.request("signup", data),
      cookie = s.cookie.split(";")[0];
    assert.equal(s.body.token, undefined);
    assert.equal(f.mails().length, 1);
    const token = f.tokenFor("verify");
    assert.equal((await f.request("verify-email", { token })).status, 200);
    assert.equal((await f.request("verify-email", { token })).status, 400);
    assert.equal(
      (await f.request("session", undefined, cookie, "GET")).body.user
        .emailVerified,
      true,
    );
    assert.equal(
      (await f.request("verify-email", { token: "bad" })).status,
      400,
    );
  } finally {
    await f.close();
  }
});
test("password reset invalidates old sessions, rejects expired tokens and cannot be replayed", async () => {
  const f = await setup();
  try {
    const s = await f.request("signup", data),
      cookie = s.cookie.split(";")[0];
    const known = await f.request("forgot-password", { email: data.email }),
      unknown = await f.request("forgot-password", {
        email: "missing@example.com",
      });
    assert.deepEqual(known.body, unknown.body);
    const token = f.tokenFor("reset");
    const db = f.pool;
    await db.query("UPDATE tokens SET expires_at=0 WHERE kind='reset'");

    assert.equal(
      (await f.request("reset-password", { token, password: "NewSecret123!" }))
        .status,
      400,
    );
    await f.request("forgot-password", { email: data.email });
    const resetToken = f
      .mails()
      .filter((m) => m.subject.includes("Reset"))
      .map((m) =>
        new URL(m.text.match(/http[^\s]+/)[0]).searchParams.get("token"),
      )
      .find((t) => t !== token);
    assert.equal(
      (
        await f.request("reset-password", {
          token: resetToken,
          password: "NewSecret123!",
        })
      ).status,
      200,
    );
    assert.equal(
      (await f.request("session", undefined, cookie, "GET")).body.user,
      null,
    );
    assert.equal(
      (
        await f.request("reset-password", {
          token: resetToken,
          password: "AgainSecret123!",
        })
      ).status,
      400,
    );
    assert.equal(
      (await f.request("login", { email: data.email, password: data.password }))
        .status,
      401,
    );
    assert.equal(
      (
        await f.request("login", {
          email: data.email,
          password: "NewSecret123!",
        })
      ).status,
      200,
    );
    assert.ok(f.revoked.length);
  } finally {
    await f.close();
  }
});
test("Google credentials are verified and do not silently link an existing email account", async () => {
  const f = await setup();
  try {
    assert.equal(
      (await f.request("google", { credential: "invalid" })).status,
      401,
    );
    const first = await f.request("google", { credential: "google-user" });
    assert.equal(first.status, 200);
    assert.equal(first.body.user.emailVerified, true);
    assert.equal(first.body.user.googleConnected, true);
    const repeat = await f.request("google", { credential: "google-user" });
    assert.equal(repeat.body.user.id, first.body.user.id);
    await f.request("signup", { ...data, email: "collision@example.com" });
    assert.equal(
      (await f.request("google", { credential: "collision" })).status,
      409,
    );
  } finally {
    await f.close();
  }
});
test("profile endpoints require a session, reject foreign origins, and validate input", async () => {
  const f = await setup();
  try {
    assert.equal(
      (
        await f.request(
          "profile",
          { name: "Changed", avatar: 2 },
          null,
          "PATCH",
        )
      ).status,
      401,
    );
    const s = await f.request("signup", data),
      cookie = s.cookie.split(";")[0];
    assert.equal(
      (
        await f.request(
          "profile",
          { name: "Changed", avatar: 2 },
          cookie,
          "PATCH",
          "https://evil.example",
        )
      ).status,
      403,
    );
    const updated = await f.request(
      "profile",
      { name: "Changed", avatar: 2 },
      cookie,
      "PATCH",
      "http://localhost:5173",
    );
    assert.equal(updated.status, 200);
    assert.equal(updated.body.user.name, "Changed");
    assert.equal(updated.body.user.avatar, 2);
    assert.equal(
      (await f.request("profile", { name: "", avatar: 99 }, cookie, "PATCH"))
        .status,
      400,
    );
    assert.equal(
      (await f.request("signup", { ...data, email: "not-email" })).status,
      400,
    );
    assert.equal(
      (await f.request("signup", { ...data, password: "short" })).status,
      400,
    );
    assert.equal((await f.request("signup", data)).status, 409);
  } finally {
    await f.close();
  }
});

test("tutorial invitation and completion are saved per account", async () => {
  const f = await setup();
  try {
    assert.equal(
      (await f.request("tutorial", { status: "skipped" })).status,
      401,
    );
    const signup = await f.request("signup", data),
      cookie = signup.cookie.split(";")[0];
    assert.equal(signup.body.user.tutorialStatus, "new");
    assert.equal(
      (await f.request("tutorial", { status: "unknown" }, cookie)).status,
      400,
    );
    const skipped = await f.request("tutorial", { status: "skipped" }, cookie);
    assert.equal(skipped.body.user.tutorialStatus, "skipped");
    await f.restart();
    assert.equal(
      (await f.request("session", undefined, cookie, "GET")).body.user
        .tutorialStatus,
      "skipped",
    );
    const completed = await f.request(
      "tutorial",
      { status: "completed" },
      cookie,
    );
    assert.equal(completed.body.user.tutorialStatus, "completed");
    assert.equal(
      (await f.request("tutorial", { status: "skipped" }, cookie)).body.user
        .tutorialStatus,
      "completed",
    );
  } finally {
    await f.close();
  }
});

test("verification and reset use the selected mail service; failed delivery preserves prior links", async () => {
  const messages = [];
  let failing = false;
  const mailer = {
    mode: "resend",
    send: async (message) => {
      if (failing)
        throw Object.assign(new Error("Provider unavailable"), {
          code: "EMAIL_DELIVERY_UNAVAILABLE",
          status: 503,
        });
      messages.push(message);
      return { id: "test-email" };
    },
  };
  const f = await setup({ mailer });
  try {
    const signup = await f.request("signup", data),
      cookie = signup.cookie.split(";")[0];
    assert.equal(signup.body.emailDelivery, "resend");
    assert.equal(signup.body.emailSent, true);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].to, data.email);
    const verifyToken = new URL(
      messages[0].text.match(/http[^\s]+/)[0],
    ).searchParams.get("token");
    failing = true;
    assert.equal(
      (await f.request("resend-verification", {}, cookie)).status,
      503,
    );
    assert.equal(
      (await f.request("verify-email", { token: verifyToken })).status,
      200,
    );
    failing = false;
    await f.request("forgot-password", { email: data.email });
    assert.equal(messages.length, 2);
    assert.match(messages[1].subject, /Reset/);
    const token = new URL(
      messages[1].text.match(/http[^\s]+/)[0],
    ).searchParams.get("token");
    assert.equal(
      (
        await f.request("reset-password", {
          token,
          password: "ResetUsingAPI123!",
        })
      ).status,
      200,
    );
  } finally {
    await f.close();
  }
});

test("Brevo HTTPS adapter completes verification, reset and deletion confirmation through account routes", async () => {
  const sent = [];
  const { createMailer } = require("../src/mailer");
  const mailer = createMailer({
    env: {
      MAIL_PROVIDER: "brevo",
      BREVO_API_KEY: "test-only-brevo-key",
      MAIL_FROM: "BluffX <sender@example.com>",
    },
    fetchImpl: async (_url, options) => {
      sent.push(JSON.parse(options.body));
      return {
        ok: true,
        json: async () => ({ messageId: "test-message-" + sent.length }),
      };
    },
  });
  const f = await setup({ mailer });
  const token = () =>
    new URL(sent.at(-1).textContent.match(/http[^\s]+/)[0]).searchParams.get(
      "token",
    );
  try {
    const signup = await f.request("signup", data);
    assert.equal(signup.body.emailDelivery, "brevo");
    assert.equal(signup.body.emailSent, true);
    assert.equal(sent[0].to[0].email, data.email);
    assert.equal(
      (await f.request("verify-email", { token: token() })).status,
      200,
    );
    await f.request("forgot-password", { email: data.email });
    assert.equal(
      (
        await f.request("reset-password", {
          token: token(),
          password: "NewBrevoPassword123!",
        })
      ).status,
      200,
    );
    const login = await f.request("login", {
      email: data.email,
      password: "NewBrevoPassword123!",
    });
    assert.equal(login.status, 200);
    assert.equal(
      (
        await f.request(
          "request-account-deletion",
          {},
          login.cookie.split(";")[0],
        )
      ).status,
      200,
    );
    assert.match(sent.at(-1).subject, /Confirm deletion/i);
    assert.equal(
      (await f.request("confirm-account-deletion", { token: token() })).status,
      200,
    );
    assert.equal(sent.length, 3);
  } finally {
    await f.close();
  }
});
