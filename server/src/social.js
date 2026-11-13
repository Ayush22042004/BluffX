const crypto = require("node:crypto");
const invalid = (message, status = 400) =>
  Object.assign(Error(message), { status });
const rows = async (db, sql, ...args) => (await db.run(sql, ...args)).rows;
function installSocial({ route, requireUser, db, service, notify = () => {} }) {
  async function me(req) {
    const s = await requireUser(req);
    if (!s.user.email_verified)
      throw invalid("Verify your email to use social features.", 403);
    await db.run(
      "INSERT INTO bx_social_profiles(user_id,handle) VALUES(?,?) ON CONFLICT(user_id) DO NOTHING",
      s.user.id,
      crypto.randomBytes(8).toString("hex"),
    );
    return s.user.id;
  }
  async function target(handle) {
    if (typeof handle !== "string" || !/^[a-f0-9]{16}$/.test(handle))
      throw invalid("Use the exact public player identifier.");
    const p = await db.get(
      "SELECT p.user_id FROM bx_social_profiles p JOIN users u ON u.id=p.user_id WHERE p.handle=? AND u.email_verified=1 AND u.deleted_at IS NULL",
      handle,
    );
    if (!p) throw invalid("Player not found.", 404);
    return p.user_id;
  }
  async function blocked(a, b, q = db) {
    return !!(await q.get(
      "SELECT owner FROM bx_blocks WHERE (owner=? AND target=?) OR (owner=? AND target=?)",
      a,
      b,
      b,
      a,
    ));
  }
  const friends = (a, b, q = db) =>
    q.get(
      "SELECT sender FROM bx_friends WHERE ((sender=? AND recipient=?) OR (sender=? AND recipient=?)) AND status='accepted'",
      a,
      b,
      b,
      a,
    );
  const publicFields = "p.handle,u.name,u.avatar";
  route("get", "/social", async (req, res) => {
    const id = await me(req),
      profile = await db.get(
        "SELECT handle,requests_enabled,invites_enabled,recent_enabled FROM bx_social_profiles WHERE user_id=?",
        id,
      );
    const list = await rows(
      db,
      `SELECT ${publicFields},f.status,CASE WHEN f.recipient=? THEN TRUE ELSE FALSE END AS incoming FROM bx_friends f JOIN bx_social_profiles p ON p.user_id=CASE WHEN f.sender=? THEN f.recipient ELSE f.sender END JOIN users u ON u.id=p.user_id WHERE (f.sender=? OR f.recipient=?) AND f.status<>'declined' AND u.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM bx_blocks b WHERE (b.owner=? AND b.target=p.user_id) OR (b.target=? AND b.owner=p.user_id)) ORDER BY f.updated_at DESC LIMIT 100`,
      id,
      id,
      id,
      id,
      id,
      id,
    );
    const invites = await rows(
      db,
      `SELECT i.token,i.room_code,i.expires_at,p.handle,u.name FROM bx_invites i JOIN bx_social_profiles p ON p.user_id=i.sender JOIN users u ON u.id=i.sender WHERE i.recipient=? AND i.expires_at>? AND NOT EXISTS(SELECT 1 FROM bx_blocks b WHERE (b.owner=? AND b.target=i.sender) OR (b.target=? AND b.owner=i.sender)) ORDER BY i.expires_at DESC LIMIT 20`,
      id,
      Date.now(),
      id,
      id,
    );
    const blocks = await rows(
      db,
      `SELECT ${publicFields} FROM bx_blocks b JOIN bx_social_profiles p ON p.user_id=b.target JOIN users u ON u.id=p.user_id WHERE b.owner=? LIMIT 100`,
      id,
    );
    // Presence is intentionally omitted rather than exposing activity to unauthorized viewers.
    res.json({ profile, players: list, invites, blocks });
  });
  route("get", "/social/search", async (req, res) => {
    const id = await me(req),
      handle = String(req.query.handle || "");
    if (!/^[a-f0-9]{16}$/.test(handle)) return res.json({ players: [] });
    res.json({
      players: await rows(
        db,
        `SELECT ${publicFields} FROM bx_social_profiles p JOIN users u ON u.id=p.user_id WHERE p.handle=? AND p.user_id<>? AND p.requests_enabled=TRUE AND u.email_verified=1 AND u.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM bx_blocks b WHERE (b.owner=? AND b.target=p.user_id) OR (b.target=? AND b.owner=p.user_id)) LIMIT 1`,
        handle,
        id,
        id,
        id,
      ),
    });
  });
  route("post", "/social/preferences", async (req, res) => {
    const id = await me(req),
      d = req.body;
    if (
      ["requests", "invites", "recent"].some((k) => typeof d[k] !== "boolean")
    )
      throw invalid("Preferences must be boolean.");
    await db.run(
      "UPDATE bx_social_profiles SET requests_enabled=?,invites_enabled=?,recent_enabled=? WHERE user_id=?",
      d.requests,
      d.invites,
      d.recent,
      id,
    );
    res.json({ ok: true });
  });
  route("post", "/social/action", async (req, res) => {
    const id = await me(req),
      other = await target(req.body.handle),
      action = req.body.action;
    if (id === other) throw invalid("Choose another player.");
    await db.transaction(async (q) => {
      // Lock the existing user rows in a stable order to serialize request/block races.
      await q.run(
        "SELECT id FROM users WHERE id IN (?,?) ORDER BY id FOR UPDATE",
        id,
        other,
      );
      if (action === "unblock") {
        await q.run(
          "DELETE FROM bx_blocks WHERE owner=? AND target=?",
          id,
          other,
        );
        return;
      }
      if (action === "block") {
        await q.run(
          "INSERT INTO bx_blocks(owner,target) VALUES(?,?) ON CONFLICT DO NOTHING",
          id,
          other,
        );
        await q.run(
          "DELETE FROM bx_friends WHERE (sender=? AND recipient=?) OR (sender=? AND recipient=?)",
          id,
          other,
          other,
          id,
        );
        await q.run(
          "DELETE FROM bx_invites WHERE (sender=? AND recipient=?) OR (sender=? AND recipient=?)",
          id,
          other,
          other,
          id,
        );
        return;
      }
      if (await blocked(id, other, q))
        throw invalid("This interaction is unavailable.", 403);
      if (action === "request") {
        const p = await q.get(
          "SELECT requests_enabled FROM bx_social_profiles WHERE user_id=?",
          other,
        );
        if (!p?.requests_enabled)
          throw invalid("Friend requests are disabled.", 403);
        const existing = await q.get(
          "SELECT status,updated_at FROM bx_friends WHERE (sender=? AND recipient=?) OR (sender=? AND recipient=?)",
          id,
          other,
          other,
          id,
        );
        if (
          existing &&
          (existing.status !== "declined" ||
            Date.now() - Number(existing.updated_at) < 86400000)
        )
          throw invalid("A request already exists or is cooling down.", 409);
        const total = await q.get(
          "SELECT COUNT(*) AS n FROM bx_friends WHERE (sender=? OR recipient=?) AND status<>'declined'",
          id,
          id,
        );
        if (Number(total.n) >= 100)
          throw invalid("Friend/request limit reached.", 429);
        const count = await q.get(
          "SELECT COUNT(*) AS n FROM bx_friends WHERE sender=? AND updated_at>?",
          id,
          Date.now() - 86400000,
        );
        if (Number(count.n) >= 20)
          throw invalid("Daily friend request limit reached.", 429);
        await q.run(
          "DELETE FROM bx_friends WHERE (sender=? AND recipient=?) OR (sender=? AND recipient=?)",
          id,
          other,
          other,
          id,
        );
        await q.run(
          "INSERT INTO bx_friends(sender,recipient,status,updated_at) VALUES(?,?,'pending',?)",
          id,
          other,
          Date.now(),
        );
      } else if (action === "accept" || action === "decline") {
        const result = await q.run(
          "UPDATE bx_friends SET status=?,updated_at=? WHERE sender=? AND recipient=? AND status='pending'",
          action === "accept" ? "accepted" : "declined",
          Date.now(),
          other,
          id,
        );
        if (!result.rowCount) throw invalid("No pending request.", 409);
      } else if (action === "remove") {
        await q.run(
          "UPDATE bx_friends SET status='declined',updated_at=? WHERE (sender=? AND recipient=?) OR (sender=? AND recipient=?)",
          Date.now(),
          id,
          other,
          other,
          id,
        );
      } else throw invalid("Unknown social action.");
    });
    if (["request", "accept", "decline", "remove"].includes(action))
      notify(other);
    res.json({ ok: true });
  });
  route("post", "/social/invite", async (req, res) => {
    const id = await me(req),
      other = await target(req.body.handle),
      room = service.rooms.get(String(req.body.roomId || "").toUpperCase());
    if (
      !room ||
      room.phase !== "lobby" ||
      room.closed ||
      room.players.length >= room.maxPlayers ||
      !room.players.some((p) => p.accountId === id)
    )
      throw invalid("Invite from an available table lobby.", 409);
    if ((await blocked(id, other)) || !(await friends(id, other)))
      throw invalid("Only current friends can be invited.", 403);
    const p = await db.get(
      "SELECT invites_enabled FROM bx_social_profiles WHERE user_id=?",
      other,
    );
    if (!p?.invites_enabled) throw invalid("Invitations are disabled.", 403);
    const old = await db.get(
      "SELECT expires_at FROM bx_invites WHERE sender=? AND recipient=? AND room_code=?",
      id,
      other,
      room.id,
    );
    if (old && Number(old.expires_at) > Date.now())
      throw invalid("An invitation is already active.", 409);
    await db.run(
      "INSERT INTO bx_invites(token,sender,recipient,room_code,expires_at) VALUES(?,?,?,?,?) ON CONFLICT(sender,recipient,room_code) DO UPDATE SET token=EXCLUDED.token,expires_at=EXCLUDED.expires_at",
      crypto.randomBytes(24).toString("hex"),
      id,
      other,
      room.id,
      Date.now() + 600000,
    );
    notify(other);
    res.json({ ok: true });
  });
  route("get", "/social/invite/:token", async (req, res) => {
    const id = await me(req),
      i = await db.get(
        "SELECT sender,room_code,expires_at FROM bx_invites WHERE token=? AND recipient=?",
        req.params.token,
        id,
      );
    if (
      !i ||
      Number(i.expires_at) <= Date.now() ||
      (await blocked(id, i.sender)) ||
      !(await friends(id, i.sender))
    )
      throw invalid("Invitation expired or unavailable.", 410);
    const room = service.rooms.get(i.room_code);
    if (!room || room.phase !== "lobby" || room.closed)
      throw invalid("This table is no longer available.", 410);
    if (room.players.length >= room.maxPlayers)
      throw invalid("This table is full.", 409);
    // This only reveals the code. Normal join still enforces password, bans and admissions.
    res.json({ roomId: room.id, passwordRequired: !!room.passwordHash });
  });
  route("get", "/social/recent", async (req, res) => {
    const id = await me(req),
      profile = await db.get(
        "SELECT recent_enabled FROM bx_social_profiles WHERE user_id=?",
        id,
      );
    if (!profile.recent_enabled) return res.json({ players: [] });
    const players = await rows(
      db,
      `WITH recent_matches AS (SELECT r.match_id,m.completed_at FROM bx_results r JOIN bx_matches m ON m.match_id=r.match_id WHERE r.user_id=? AND m.finalized=TRUE ORDER BY m.completed_at DESC LIMIT 20) SELECT ${publicFields} FROM recent_matches mine JOIN bx_results other ON other.match_id=mine.match_id JOIN bx_social_profiles p ON p.user_id=other.user_id JOIN users u ON u.id=p.user_id WHERE p.user_id<>? AND p.recent_enabled=TRUE AND u.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM bx_blocks b WHERE (b.owner=? AND b.target=p.user_id) OR (b.target=? AND b.owner=p.user_id)) GROUP BY p.handle,u.name,u.avatar ORDER BY MAX(mine.completed_at) DESC,p.handle LIMIT 20`,
      id,
      id,
      id,
      id,
    );
    res.json({ players });
  });
}
module.exports = { installSocial };
