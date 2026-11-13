const express = require("express");
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const path = require("node:path");
const { createDatabase } = require("./database");
const { OAuth2Client } = require("google-auth-library");
const { createMailer } = require("./mailer");
const { installAvatars, validAvatarId } = require("./avatars");
const { createRateIdentity } = require("./rate-identity");
const scrypt = promisify(crypto.scrypt);
let passwordJobs = 0;
const passwordQueue = [];
async function passwordWork(work) {
  if (passwordJobs >= 2) {
    if (passwordQueue.length >= 16)
      throw fail(429, "Sign-in is busy. Try again in a moment.");
    await new Promise((resolve) => passwordQueue.push(resolve));
  } else passwordJobs++;
  try {
    return await work();
  } finally {
    const next = passwordQueue.shift();
    if (next) next();
    else passwordJobs--;
  }
}
const COOKIE = "bluffx_session";
const digest = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");
const fail = (status, message) => Object.assign(new Error(message), { status });
const emailOf = (value) => {
  if (
    typeof value !== "string" ||
    value.length > 254 ||
    !/^\S+@[^\s@]+\.[^\s@]+$/.test(value.trim())
  )
    throw fail(400, "Enter a valid email address.");
  return value.trim().toLowerCase();
};
const passwordOf = (value) => {
  if (typeof value !== "string" || value.length < 8 || value.length > 128)
    throw fail(400, "Use a password between 8 and 128 characters.");
  return value;
};
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return (
    salt +
    ":" +
    (await passwordWork(() => scrypt(password, salt, 64))).toString("hex")
  );
}
async function checkPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  return crypto.timingSafeEqual(
    await passwordWork(() => scrypt(password, salt, 64)),
    Buffer.from(hash, "hex"),
  );
}
async function createAuth({
  allowedOrigins,
  onRevoke = () => {},
  onErase = async () => {},
  databaseUrl = process.env.DATABASE_URL,
  pool,
  outboxPath = process.env.MAIL_OUTBOX_PATH ||
    path.resolve(__dirname, "../.data/mail"),
  googleClientId = process.env.GOOGLE_CLIENT_ID || "",
  googleVerifier,
  mailer,
  cookieSameSite = process.env.SESSION_COOKIE_SAME_SITE || "lax",
  production = process.env.NODE_ENV === "production",
} = {}) {
  if (!["lax", "strict", "none"].includes(cookieSameSite))
    throw Error("SESSION_COOKIE_SAME_SITE must be lax, strict, or none.");
  if (cookieSameSite === "none" && !production)
    throw Error("SameSite=None requires NODE_ENV=production and HTTPS.");
  const db = await createDatabase({ connectionString: databaseUrl, pool });
  const emailService = mailer || createMailer({ outboxPath });
  const mailMode = emailService.mode;
  const appOrigin = new URL(process.env.APP_ORIGIN || "http://localhost:5173")
    .origin;
  const router = express.Router();
  router.use(express.json({ limit: "12kb" }));
  const publicUser = (u) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    avatar: u.avatar,
    avatarId: u.avatar_id || null,
    emailVerified: Boolean(u.email_verified),
    hasPassword: Boolean(u.password_hash),
    googleConnected: Boolean(u.google_sub),
    tutorialStatus: u.tutorial_status || "new",
  });
  const userById = async (id) =>
    await db.get(
      "SELECT u.*,a.id AS avatar_id FROM users u LEFT JOIN player_avatars a ON a.user_id=u.id WHERE u.id=?",
      id,
    );
  async function sessionFromCookie(header = "") {
    const raw = header
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith(COOKIE + "="))
      ?.slice(COOKIE.length + 1);
    if (!raw || !/^[a-f0-9]{64}$/.test(raw)) return null;
    const hash = digest(raw);
    const session = await db.get(
      "SELECT * FROM sessions WHERE hash=? AND expires_at>?",
      hash,
      Date.now(),
    );
    if (!session) return null;
    const user = await userById(session.user_id);
    return user && !user.deleted_at ? { user, hash } : null;
  }
  const cookieOptions = {
    httpOnly: true,
    secure: production,
    sameSite: cookieSameSite,
    path: "/",
  };
  async function newSession(res, user) {
    const raw = crypto.randomBytes(32).toString("hex");
    await db.run(
      "INSERT INTO sessions VALUES(?,?,?)",
      digest(raw),
      user.id,
      Date.now() + 30 * 86400000,
    );
    res.cookie(COOKIE, raw, { ...cookieOptions, maxAge: 30 * 86400000 });
  }
  async function email(user, kind) {
    if (mailMode === "unavailable")
      throw fail(503, "Email delivery has not been configured.");
    const token = crypto.randomBytes(32).toString("hex");
    const link = `${appOrigin}/?auth=${kind}&token=${token}`;
    const message = {
      from: process.env.MAIL_FROM || "BluffX <no-reply@bluffx.local>",
      to: user.email,
      subject:
        kind === "delete"
          ? "Confirm deletion of your BluffX account"
          : kind === "reset"
            ? "Reset your BluffX password"
            : "Verify your BluffX email",
      text:
        kind === "delete"
          ? `Confirm deletion of your BluffX account using this link (expires in 30 minutes):\n\n${link}\n\nThis removes your profile and anonymizes match records. If you did not request this, ignore this email.`
          : kind === "reset"
            ? `Reset your BluffX password using this link (expires in 30 minutes):\n\n${link}\n\nIf you did not request this, ignore this email.`
            : `Verify your BluffX email address using this link (expires in 24 hours):\n\n${link}\n\nIf you did not create this account, ignore this email.`,
    };
    await emailService.send(message);
    // A failed delivery must not invalidate an earlier usable verification/reset link.
    await db.transaction(async (tx) => {
      await tx.run(
        "DELETE FROM tokens WHERE user_id=? AND kind=?",
        user.id,
        kind,
      );
      await tx.run(
        "INSERT INTO tokens VALUES(?,?,?,?)",
        digest(token),
        user.id,
        kind,
        Date.now() +
          (["reset", "delete"].includes(kind) ? 30 * 60000 : 24 * 3600000),
      );
    });
  }
  const rate = new Map();
  const browserIdentity = createRateIdentity();
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    const browser = ["GET", "HEAD"].includes(req.method)
      ? browserIdentity.ensure(req, res, cookieOptions)
      : browserIdentity.read(req.headers.cookie) || "ip:" + req.ip;
    if (["GET", "HEAD"].includes(req.method)) return next();
    const requestOrigin = req.headers.origin;
    if (requestOrigin && !allowedOrigins?.has(requestOrigin))
      return res
        .status(403)
        .json({ message: "This request origin is not allowed." });
    const identity =
      typeof req.body?.email === "string"
        ? "email:" + digest(req.body.email.trim().toLowerCase())
        : browser;
    const coarseKey = "ip:" + req.ip,
      coarse = rate.get(coarseKey),
      timestamp = Date.now();
    if (coarse?.until > timestamp && coarse.count++ >= 500)
      return res
        .status(429)
        .json({ message: "Too many requests. Try again shortly." });
    if (!coarse || coarse.until <= timestamp)
      rate.set(coarseKey, { until: timestamp + 15 * 60000, count: 1 });
    const key = identity + ":" + req.path,
      now = Date.now(),
      entry = rate.get(key);
    if (entry && entry.until > now) {
      if (entry.count++ >= 20) {
        res.set("Retry-After", String(Math.ceil((entry.until - now) / 1000)));
        return res
          .status(429)
          .json({ message: "Too many attempts. Try again in a few minutes." });
      }
    } else rate.set(key, { until: now + 15 * 60000, count: 1 });
    if (rate.size > 10000)
      for (const [key, v] of rate) if (v.until < now) rate.delete(key);
    next();
  });
  const route = (method, url, handler) =>
    router[method](url, (req, res, next) =>
      Promise.resolve()
        .then(() => handler(req, res))
        .catch(next),
    );
  async function requireUser(req) {
    const session = await sessionFromCookie(req.headers.cookie);
    if (!session) throw fail(401, "Please sign in again.");
    return session;
  }
  const avatars = installAvatars({
    router,
    route,
    db,
    sessionFromCookie,
    cookieOptions,
  });
  route("get", "/config", (_req, res) =>
    res.json({
      googleClientId,
      emailDelivery: mailMode,
      playtestUnranked: process.env.PLAYTEST_UNRANKED === "true",
      rankedPairDailyLimit: require("./rules").RULES.rankedPairDailyLimit,
    }),
  );
  route("get", "/session", async (req, res) => {
    const s = await sessionFromCookie(req.headers.cookie);
    res.json({ user: s ? publicUser(s.user) : null });
  });
  route("post", "/signup", async (req, res) => {
    const emailAddress = emailOf(req.body.email),
      password = passwordOf(req.body.password),
      name =
        typeof req.body.name === "string"
          ? req.body.name.trim().slice(0, 20)
          : "";
    if (!name) throw fail(400, "Enter your player name.");
    if (
      process.env.PLAYTEST_INVITE_ONLY === "true" &&
      !(process.env.PLAYTEST_ALLOWED_EMAILS || "")
        .split(",")
        .map((v) => v.trim().toLowerCase())
        .includes(emailAddress)
    )
      throw fail(
        403,
        "This playtest is currently limited to invited accounts.",
      );
    if (await db.get("SELECT id FROM users WHERE email=?", emailAddress))
      throw fail(
        409,
        "This email is already registered. Sign in or reset your password.",
      );
    const hash = await hashPassword(password);
    const user = {
      id: crypto.randomUUID(),
      email: emailAddress,
      name,
      avatar: 0,
      password_hash: hash,
      email_verified: 0,
    };
    try {
      await db.run(
        "INSERT INTO users(id,email,name,password_hash,created_at) VALUES(?,?,?,?,?)",
        user.id,
        emailAddress,
        name,
        hash,
        Date.now(),
      );
    } catch (e) {
      if (e.code === "23505")
        throw fail(409, "This email is already registered.");
      throw e;
    }
    let emailSent = true;
    try {
      await email(user, "verify");
    } catch (error) {
      emailSent = false;
      console.warn(
        "Verification email delivery failed:",
        error.code || error.status || "delivery error",
      );
    }
    await newSession(res, user);
    res
      .status(201)
      .json({ user: publicUser(user), emailSent, emailDelivery: mailMode });
  });
  // Always run a password derivation, including for unknown emails, to reduce timing differences.
  const dummyHashPromise = hashPassword(crypto.randomBytes(32).toString("hex"));
  route("post", "/login", async (req, res) => {
    const address = emailOf(req.body.email),
      password = passwordOf(req.body.password),
      user = await db.get("SELECT * FROM users WHERE email=?", address);
    const valid = await checkPassword(
      password,
      user?.password_hash || (await dummyHashPromise),
    );
    if (!user || !user.password_hash || !valid)
      throw fail(401, "Email or password is incorrect.");
    await newSession(res, user);
    res.json({ user: publicUser(await userById(user.id)) });
  });
  route("post", "/google", async (req, res) => {
    if (!googleClientId)
      throw fail(503, "Google sign-in has not been configured yet.");
    if (
      typeof req.body.credential !== "string" ||
      req.body.credential.length > 10000
    )
      throw fail(400, "Invalid Google sign-in response.");
    let claims;
    try {
      claims = googleVerifier
        ? await googleVerifier(req.body.credential)
        : (
            await new OAuth2Client(googleClientId).verifyIdToken({
              idToken: req.body.credential,
              audience: googleClientId,
            })
          ).getPayload();
    } catch {
      throw fail(
        401,
        "Google could not verify this sign-in. Please try again.",
      );
    }
    if (!claims?.sub || !claims.email_verified)
      throw fail(401, "Choose a Google account with a verified email.");
    let user = await db.get(
      "SELECT * FROM users WHERE google_sub=?",
      claims.sub,
    );
    if (!user) {
      const address = emailOf(claims.email);
      if (await db.get("SELECT id FROM users WHERE email=?", address))
        throw fail(
          409,
          "This email already has a BluffX account. Sign in using your email and password.",
        );
      const id = crypto.randomUUID();
      await db.run(
        "INSERT INTO users(id,email,name,google_sub,email_verified,created_at) VALUES(?,?,?,?,1,?)",
        id,
        address,
        String(claims.name || address.split("@")[0]).slice(0, 20),
        claims.sub,
        Date.now(),
      );
      user = await userById(id);
    }
    await newSession(res, user);
    res.json({ user: publicUser(await userById(user.id)) });
  });
  route("post", "/logout", async (req, res) => {
    const s = await sessionFromCookie(req.headers.cookie);
    if (s) {
      await db.run("DELETE FROM sessions WHERE hash=?", s.hash);
      onRevoke(s.user.id, s.hash);
    }
    res.clearCookie(COOKIE, cookieOptions);
    res.json({ ok: true });
  });
  route("post", "/tutorial", async (req, res) => {
    const { user } = await requireUser(req);
    if (!["skipped", "completed"].includes(req.body.status))
      throw fail(400, "Invalid tutorial status.");
    // Replaying and exiting must not remove an earlier completion.
    await db.run(
      "UPDATE users SET tutorial_status=CASE WHEN tutorial_status='completed' THEN 'completed' ELSE ? END WHERE id=?",
      req.body.status,
      user.id,
    );
    res.json({ user: publicUser(await userById(user.id)) });
  });
  route("patch", "/profile", async (req, res) => {
    const { user } = await requireUser(req),
      name =
        typeof req.body.name === "string"
          ? req.body.name.trim().slice(0, 20)
          : "",
      avatar = req.body.avatar;
    if (!name || !Number.isInteger(avatar) || avatar < 0 || avatar > 5)
      throw fail(400, "Choose a name and a valid avatar.");
    if (!validAvatarId(req.body.avatarId)) throw fail(400, "Invalid avatar.");
    if (req.body.avatarId) {
      const owned = await db.get(
        "SELECT id FROM player_avatars WHERE id=? AND user_id=?",
        req.body.avatarId,
        user.id,
      );
      if (!owned) throw fail(400, "Upload your own avatar first.");
    }
    await db.transaction(async (tx) => {
      if (!req.body.avatarId && Object.hasOwn(req.body, "avatarId"))
        await avatars.clearUser(user.id, tx);
      await tx.run(
        "UPDATE users SET name=?,avatar=? WHERE id=?",
        name,
        avatar,
        user.id,
      );
    });
    res.json({ user: publicUser(await userById(user.id)) });
  });
  route("post", "/forgot-password", async (req, res) => {
    const address = emailOf(req.body.email);
    if (mailMode === "unavailable")
      throw fail(
        503,
        "Password reset email is unavailable. Contact the game host.",
      );
    const user = await db.get("SELECT * FROM users WHERE email=?", address);
    if (user?.password_hash)
      try {
        await email(user, "reset");
      } catch (error) {
        console.warn(
          "Reset email delivery failed:",
          error.code || "delivery error",
        );
      }
    res.json({
      message:
        "If this email has a password account, reset instructions have been sent.",
      emailDelivery: mailMode,
    });
  });
  async function tokenFor(token, kind, store = db, lock = false) {
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token))
      throw fail(400, "This link is invalid or has expired.");
    const row = await store.get(
      "SELECT * FROM tokens WHERE hash=? AND kind=? AND expires_at>?" +
        (lock ? " FOR UPDATE" : ""),
      digest(token),
      kind,
      Date.now(),
    );
    if (!row)
      throw fail(
        400,
        "This link is invalid or has expired. Request a new one.",
      );
    return row;
  }
  let erasing = false;
  async function processErasures() {
    if (erasing) return;
    erasing = true;
    try {
      const rows = await db.run(
        "SELECT user_id FROM account_erasure ORDER BY requested_at LIMIT 10",
      );
      for (const row of rows.rows) {
        await onErase(row.user_id);
        await db.transaction(async (tx) => {
          await tx.run("DELETE FROM sessions WHERE user_id=?", row.user_id);
          await tx.run("DELETE FROM tokens WHERE user_id=?", row.user_id);
          await avatars.clearUser(row.user_id, tx);
          await tx.run("DELETE FROM users WHERE id=?", row.user_id);
          await tx.run(
            "DELETE FROM account_erasure WHERE user_id=?",
            row.user_id,
          );
        });
      }
    } finally {
      erasing = false;
    }
  }
  route("post", "/request-account-deletion", async (req, res) => {
    const session = await requireUser(req);
    await email(session.user, "delete");
    res.json({
      ok: true,
      message: "Check your email to confirm account deletion.",
    });
  });
  route("post", "/confirm-account-deletion", async (req, res) => {
    const id = await db.transaction(async (tx) => {
      const row = await tokenFor(req.body.token, "delete", tx, true);
      await tx.run(
        "INSERT INTO account_erasure(user_id,requested_at) VALUES(?,?) ON CONFLICT(user_id) DO NOTHING",
        row.user_id,
        Date.now(),
      );
      await tx.run(
        "UPDATE users SET email=?,name='Deleted player',password_hash=NULL,google_sub=NULL,email_verified=0,deleted_at=? WHERE id=?",
        `deleted-${row.user_id}@invalid`,
        Date.now(),
        row.user_id,
      );
      await tx.run("DELETE FROM sessions WHERE user_id=?", row.user_id);
      await tx.run("DELETE FROM tokens WHERE user_id=?", row.user_id);
      await avatars.clearUser(row.user_id, tx);
      return row.user_id;
    });
    onRevoke(id);
    res.clearCookie(COOKIE, cookieOptions);
    await processErasures().catch((e) =>
      console.error("Account erasure queued:", e.code || e.name),
    );
    res.json({
      ok: true,
      message:
        "Your account has been removed. Any remaining historical anonymization will finish automatically.",
    });
  });
  route("post", "/reset-password", async (req, res) => {
    passwordOf(req.body.password);
    await tokenFor(req.body.token, "reset");
    const hash = await hashPassword(req.body.password);
    let row;
    await db.transaction(async (tx) => {
      row = await tokenFor(req.body.token, "reset", tx, true);
      await tx.run(
        "UPDATE users SET password_hash=? WHERE id=?",
        hash,
        row.user_id,
      );
      await tx.run("DELETE FROM tokens WHERE user_id=?", row.user_id);
      await tx.run("DELETE FROM sessions WHERE user_id=?", row.user_id);
    });
    onRevoke(row.user_id);
    res.clearCookie(COOKIE, cookieOptions);
    res.json({ message: "Password changed. Sign in with your new password." });
  });
  route("post", "/verify-email", async (req, res) => {
    await db.transaction(async (tx) => {
      const row = await tokenFor(req.body.token, "verify", tx, true);
      await tx.run("UPDATE users SET email_verified=1 WHERE id=?", row.user_id);
      await tx.run("DELETE FROM tokens WHERE hash=?", row.hash);
    });
    res.json({ message: "Your email is verified. You are ready to play." });
  });
  route("post", "/resend-verification", async (req, res) => {
    const { user } = await requireUser(req);
    if (user.email_verified)
      return res.json({ message: "Your email is already verified." });
    await email(user, "verify");
    res.json({ message: "Verification email sent.", emailDelivery: mailMode });
  });
  router.use((error, _req, res, _next) => {
    if (!error.status)
      console.error("Authentication request failed:", error.code || error.name);
    res.status(error.status || 500).json({
      message: error.status
        ? error.message
        : "Something went wrong. Please try again.",
    });
  });
  let lastAvatarCleanup = 0;
  const cleanup = setInterval(async () => {
    try {
      const now = Date.now();
      await db.run("DELETE FROM sessions WHERE expires_at<?", now);
      await db.run("DELETE FROM tokens WHERE expires_at<?", now);
      await processErasures();
      await db.run(
        "DELETE FROM bx_reports WHERE created_at<?",
        now - 30 * 86400000,
      );
      if (now - lastAvatarCleanup > 3600000) {
        await db.run(
          "DELETE FROM player_avatars WHERE user_id IS NULL AND created_at<?",
          now - 30 * 86400000,
        );
        lastAvatarCleanup = now;
      }
      for (const [key, v] of rate) if (v.until < now) rate.delete(key);
    } catch (error) {
      console.error("Auth cleanup failed:", error.code || error.name);
    }
  }, 60000);
  cleanup.unref();
  await processErasures();
  return {
    router,
    sessionFromCookie,
    publicUser,
    userById,
    database: db,
    rateIdentity: (header) => browserIdentity.read(header),
    async close() {
      clearInterval(cleanup);
      avatars.close();
      await db.close();
    },
  };
}
module.exports = { createAuth };
