const crypto = require("node:crypto");
const LAUNCH_SCHEMA = `ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at BIGINT;
CREATE TABLE IF NOT EXISTS account_erasure (user_id TEXT PRIMARY KEY,requested_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS bx_reports(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id) ON DELETE SET NULL,room_code TEXT,match_id TEXT,category TEXT NOT NULL,description TEXT NOT NULL,build TEXT NOT NULL,diagnostic JSONB NOT NULL,created_at BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS bx_reports_review ON bx_reports(created_at);`;
function operator(req, secret = process.env.OPS_API_TOKEN) {
  const token = req.headers.authorization?.replace(/^Bearer /, "");
  if (
    !secret ||
    secret.length < 32 ||
    typeof token !== "string" ||
    Buffer.byteLength(token) !== Buffer.byteLength(secret) ||
    !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(secret))
  )
    throw Object.assign(Error("Operator authorization required."), {
      status: 403,
    });
}
function installLaunch({ app, auth, service, io, metrics, build }) {
  const wrap = (fn) => async (req, res) => {
    try {
      res.set("Cache-Control", "no-store");
      await fn(req, res);
    } catch (e) {
      res.status(e.status || 503).json({
        message: e.status
          ? e.message
          : "This service is temporarily unavailable.",
      });
    }
  };
  app.post(
    "/auth/report",
    wrap(async (req, res) => {
      const data = req.body || {},
        allowed = ["gameplay", "voice", "connection", "abuse", "other"];
      if (
        !allowed.includes(data.category) ||
        typeof data.description !== "string" ||
        data.description.trim().length < 10 ||
        data.description.length > 2000
      )
        throw Object.assign(
          Error(
            "Choose a category and describe the problem in 10–2000 characters.",
          ),
          { status: 400 },
        );
      const session = await auth.sessionFromCookie(req.headers.cookie),
        socket = io.sockets.sockets.get(data.socketId);
      const room = service.rooms.get(socket?.data.roomId);
      const owns =
        socket &&
        (session
          ? socket.data.accountId === session.user.id
          : !socket.data.accountId &&
            auth.rateIdentity(req.headers.cookie) === socket.data.rateIdentity);
      const context =
        owns &&
        room?.players.some(
          (p) =>
            p.id === socket.data.playerId &&
            p.controlGeneration === socket.data.generation,
        )
          ? room
          : null;
      const id = crypto.randomUUID();
      const diagnostic = {
        codes: Array.isArray(data.codes)
          ? data.codes
              .filter((v) => typeof v === "string" && /^[A-Z_]{2,50}$/.test(v))
              .slice(-10)
          : [],
        connected: !!socket?.connected,
        contextVerified: !!context,
      };
      await auth.database.run(
        "INSERT INTO bx_reports(id,user_id,room_code,match_id,category,description,build,diagnostic,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
        id,
        session?.user.id || null,
        context?.id || null,
        context?.matchId || null,
        data.category,
        data.description.trim(),
        `${build}/${typeof data.build === "string" ? data.build.slice(0, 64) : "unknown"}`,
        JSON.stringify(diagnostic),
        Date.now(),
      );
      metrics.add("reports");
      res.status(201).json({ ok: true, id });
    }),
  );
  app.get(
    "/auth/ops/metrics",
    wrap(async (req, res) => {
      operator(req);
      res.json({
        build,
        ...metrics.report({
          activeRooms: service.rooms.size,
          connectedSockets: io.sockets.sockets.size,
        }),
      });
    }),
  );
  app.get(
    "/auth/ops/reports",
    wrap(async (req, res) => {
      operator(req);
      const rows = await auth.database.run(
        "SELECT id,room_code,match_id,category,description,build,diagnostic,created_at FROM bx_reports ORDER BY created_at DESC LIMIT 50",
      );
      res.json({ reports: rows.rows });
    }),
  );
}
function checkInvitation(session, env = process.env) {
  if (env.PLAYTEST_INVITE_ONLY !== "true") return;
  const list = (env.PLAYTEST_ALLOWED_EMAILS || "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  if (!session || !list.includes(session.user.email.toLowerCase()))
    throw Object.assign(
      Error("This playtest is currently limited to invited accounts."),
      { code: "NOT_INVITED" },
    );
  if (!session.user.email_verified)
    throw Object.assign(
      Error("Verify your email before joining this invited playtest."),
      { code: "NOT_VERIFIED" },
    );
}
module.exports = { LAUNCH_SCHEMA, installLaunch, operator, checkInvitation };
