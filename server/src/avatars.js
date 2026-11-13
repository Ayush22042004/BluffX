const crypto = require("node:crypto");
const express = require("express");
const AVATAR_SCHEMA = `CREATE TABLE IF NOT EXISTS player_avatars (
 id TEXT PRIMARY KEY,
 user_id TEXT UNIQUE REFERENCES users(id) ON DELETE CASCADE,
 guest_hash TEXT UNIQUE,
 image BYTEA NOT NULL,
 created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS player_avatars_expiry ON player_avatars(created_at) WHERE user_id IS NULL;`;
const validAvatarId = (value) =>
  value == null ||
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const fail = (status, message) => Object.assign(Error(message), { status });
let encoding = 0;
async function encodeAvatar(input) {
  if (!Buffer.isBuffer(input) || !input.length || input.length > 524288)
    throw fail(
      400,
      "Choose a PNG, JPEG or WebP image under 512 KB after resizing.",
    );
  const png = input
    .subarray(0, 8)
    .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = input[0] === 255 && input[1] === 216 && input[2] === 255;
  const webp =
    input.toString("ascii", 0, 4) === "RIFF" &&
    input.toString("ascii", 8, 12) === "WEBP";
  if (!png && !jpeg && !webp) throw fail(400, "Use a PNG, JPEG or WebP image.");
  if (encoding >= 2)
    throw fail(429, "Image processing is busy. Try again in a moment.");
  encoding++;
  try {
    const sharp = require("sharp");
    sharp.cache(false);
    const image = sharp(input, { limitInputPixels: 1048576, animated: false });
    const metadata = await image.metadata();
    if (
      !["png", "jpeg", "webp"].includes(metadata.format) ||
      metadata.pages > 1
    )
      throw fail(400, "Use a still PNG, JPEG or WebP image.");
    const result = await image
      .rotate()
      .resize(128, 128, { fit: "cover" })
      .webp({ quality: 82 })
      .toBuffer();
    if (result.length > 32768)
      throw fail(400, "This image is too complex. Choose a smaller photo.");
    return result;
  } catch (e) {
    if (e.status) throw e;
    throw fail(
      400,
      "This image could not be read. Choose a valid PNG, JPEG or WebP.",
    );
  } finally {
    encoding--;
  }
}
function installAvatars({
  router,
  route,
  db,
  sessionFromCookie,
  cookieOptions,
}) {
  const cache = new Map();
  const readBudget = new Map();
  const remember = (id, image) => {
    cache.delete(id);
    cache.set(id, { image, until: Date.now() + 300000 });
    if (cache.size > 32) cache.delete(cache.keys().next().value);
  };
  async function clearUser(userId, queries = db) {
    const old = await queries.get(
      "SELECT id FROM player_avatars WHERE user_id=?",
      userId,
    );
    await queries.run("DELETE FROM player_avatars WHERE user_id=?", userId);
    if (old) cache.delete(old.id);
  }
  router.post(
    "/avatar",
    express.raw({
      type: ["image/png", "image/jpeg", "image/webp"],
      limit: "512kb",
    }),
  );
  route("post", "/avatar", async (req, res) => {
    const session = await sessionFromCookie(req.headers.cookie);
    const image = await encodeAvatar(req.body),
      id = crypto.randomUUID();
    let guestHash = null;
    if (!session) {
      let secret = (req.headers.cookie || "")
        .split(";")
        .map((x) => x.trim())
        .find((x) => x.startsWith("bluffx_avatar_guest="))
        ?.split("=")[1];
      if (!/^[a-f0-9]{64}$/.test(secret || "")) {
        secret = crypto.randomBytes(32).toString("hex");
        res.cookie("bluffx_avatar_guest", secret, {
          ...cookieOptions,
          maxAge: 30 * 86400000,
        });
      }
      guestHash = crypto.createHash("sha256").update(secret).digest("hex");
    }
    let old;
    await db.transaction(async (tx) => {
      const key = session ? "user_id" : "guest_hash",
        owner = session?.user.id || guestHash;
      old = await tx.get(`SELECT id FROM player_avatars WHERE ${key}=?`, owner);
      await tx.run(`DELETE FROM player_avatars WHERE ${key}=?`, owner);
      await tx.run(
        "INSERT INTO player_avatars(id,user_id,guest_hash,image,created_at) VALUES(?,?,?,?,?)",
        id,
        session?.user.id || null,
        guestHash,
        image,
        Date.now(),
      );
    });
    if (old) cache.delete(old.id);
    remember(id, image);
    res.status(201).json({ avatarId: id });
  });
  route("get", "/avatar/:id", async (req, res) => {
    const id = req.params.id;
    if (!validAvatarId(id)) throw fail(404, "Avatar not found.");
    let cached = cache.get(id);
    if (cached?.until < Date.now()) {
      cache.delete(id);
      cached = null;
    }
    let image = cached?.image;
    if (!image) {
      const now = Date.now(),
        key = req.ip;
      let budget = readBudget.get(key);
      if (!budget || budget.until < now) {
        if (readBudget.size >= 2048)
          for (const [ip, value] of readBudget)
            if (value.until < now) readBudget.delete(ip);
        if (readBudget.size >= 2048 && !readBudget.has(key))
          throw fail(429, "Try loading this avatar again shortly.");
        budget = { until: now + 60000, count: 0 };
        readBudget.set(key, budget);
      }
      if (++budget.count > 300) {
        res.set("Retry-After", "60");
        throw fail(429, "Too many avatar requests. Try again shortly.");
      }
      const row = await db.get(
        "SELECT image FROM player_avatars WHERE id=?",
        id,
      );
      if (!row) throw fail(404, "Avatar not found.");
      image = Buffer.from(row.image);
      remember(id, image);
    }
    const etag = `"${id}"`;
    res.set({
      "Content-Type": "image/webp",
      "Cache-Control": "public, max-age=31536000, immutable",
      ETag: etag,
      "X-Content-Type-Options": "nosniff",
    });
    if (req.headers["if-none-match"] === etag) return res.status(304).end();
    res.send(image);
  });
  return {
    clearUser,
    close: () => {
      cache.clear();
      readBudget.clear();
    },
  };
}
module.exports = { AVATAR_SCHEMA, validAvatarId, encodeAvatar, installAvatars };
