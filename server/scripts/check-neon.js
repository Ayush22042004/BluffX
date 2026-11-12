// Real database acceptance check. Creates and removes only its own test account.
require("../src/environment").loadEnvironment();
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { Pool } = require("pg");
const { verifiedConnectionString } = require("../src/database");
const { io } = require("../../client/node_modules/socket.io-client");

async function main() {
  if (!process.env.DATABASE_URL)
    throw Error("DATABASE_URL is missing; finish neon deploy first.");
  const pool = new Pool({
    connectionString: verifiedConnectionString(process.env.DATABASE_URL),
    connectionTimeoutMillis: 15000,
  });
  const outbox = fs.mkdtempSync(path.join(os.tmpdir(), "bluffx-neon-check-"));
  const email = `neon-check-${crypto.randomUUID()}@example.com`;
  const password = crypto.randomBytes(24).toString("hex");
  let child, socket, accountId, base;
  async function stop() {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    child = null;
  }
  async function start() {
    const listener = net.createServer();
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    const port = listener.address().port;
    await new Promise((resolve) => listener.close(resolve));
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ["src/index.js"], {
      cwd: path.resolve(__dirname, ".."),
      env: {
        ...process.env,
        PORT: String(port),
        MAIL_PROVIDER: "local",
        MAIL_OUTBOX_PATH: outbox,
        NODE_ENV: "development",
      },
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    });
    for (let attempt = 0; attempt < 150; attempt++) {
      if (child.exitCode !== null)
        throw Error("Backend exited before it became healthy.");
      try {
        if (
          (await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) }))
            .ok
        )
          return;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw Error("Backend did not become healthy within 15 seconds.");
  }
  async function request(route, body, cookie, method = "POST") {
    const response = await fetch(`${base}/auth/${route}`, {
      method,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    const result = await response.json();
    assert.ok(response.ok, `${route} failed with HTTP ${response.status}`);
    return {
      body: result,
      cookie: response.headers.get("set-cookie")?.split(";")[0],
    };
  }
  function token(subject) {
    const message = fs
      .readdirSync(outbox)
      .map((file) =>
        JSON.parse(fs.readFileSync(path.join(outbox, file), "utf8")),
      )
      .find(
        (message) => message.to === email && message.subject.includes(subject),
      );
    assert.ok(message, "Expected a private local email preview.");
    return new URL(message.text.match(/http[^\s]+/)[0]).searchParams.get(
      "token",
    );
  }
  try {
    await pool.query("SELECT 1");
    console.log("PASS real Neon PostgreSQL connection");
    await start();
    console.log("PASS backend startup and /health with real PostgreSQL");
    const signup = await request("signup", {
      email,
      password,
      name: "Neon Check",
    });
    accountId = signup.body.user.id;
    const cookie = signup.cookie;
    const stored = (
      await pool.query("SELECT password_hash FROM users WHERE id=$1", [
        accountId,
      ])
    ).rows[0];
    assert.ok(stored?.password_hash && stored.password_hash !== password);
    await request(
      "profile",
      { name: "Neon Verified", avatar: 3 },
      cookie,
      "PATCH",
    );
    await request("tutorial", { status: "completed" }, cookie);
    await request("verify-email", { token: token("Verify") });
    console.log(
      "PASS signup, persisted password hash, profile, tutorial and email verification",
    );
    await stop();
    await start();
    const restored = (await request("session", undefined, cookie, "GET")).body
      .user;
    assert.equal(restored.id, accountId);
    assert.equal(restored.name, "Neon Verified");
    assert.equal(restored.avatar, 3);
    assert.equal(restored.emailVerified, true);
    assert.equal(restored.tutorialStatus, "completed");
    console.log(
      "PASS account, session and profile survive a backend process restart",
    );
    socket = io(base, {
      transports: ["websocket"],
      autoConnect: false,
      extraHeaders: { Cookie: cookie },
    });
    const connected = once(socket, "connect");
    const failed = once(socket, "connect_error").then(([error]) => {
      throw error;
    });
    socket.connect();
    await Promise.race([
      connected,
      failed,
      new Promise((_, reject) => {
        setTimeout(
          () => reject(Error("Socket connection timeout")),
          10000,
        ).unref();
      }),
    ]);
    const roomState = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error("Authenticated room timeout")),
        10000,
      );
      socket.once("room_state", (state) => {
        clearTimeout(timer);
        resolve(state);
      });
      socket.once("action_error", () => {
        clearTimeout(timer);
        reject(Error("Room creation failed"));
      });
    });
    socket.emit("create_ai_room", { name: "Spoofed Name", botCount: 1 });
    assert.equal((await roomState).you.name, "Neon Verified");
    socket.disconnect();
    console.log(
      "PASS authenticated Socket.IO uses the PostgreSQL account identity",
    );
    await request("forgot-password", { email });
    await request("reset-password", {
      token: token("Reset"),
      password: password + "new",
    });
    assert.equal(
      (await request("session", undefined, cookie, "GET")).body.user,
      null,
    );
    const login = await request("login", { email, password: password + "new" });
    assert.equal(login.body.user.id, accountId);
    await request("logout", {}, login.cookie);
    assert.equal(
      (await request("session", undefined, login.cookie, "GET")).body.user,
      null,
    );
    console.log("PASS password reset, session revocation, login and logout");
  } finally {
    socket?.disconnect();
    await stop();
    try {
      // Exact unique test address only; never delete any pre-existing users.
      await pool.query("DELETE FROM users WHERE email=$1", [email]);
      console.log(
        "PASS temporary test account and related sessions/tokens removed",
      );
    } finally {
      await pool.end();
      fs.rmSync(outbox, { recursive: true, force: true });
    }
  }
}
main().catch((error) => {
  console.error("Neon acceptance check failed:", error.code || error.name);
  process.exitCode = 1;
});
