const crypto = require("node:crypto");
const runtimeSecret=process.env.RATE_IDENTITY_SECRET || crypto.randomBytes(32);
function createRateIdentity(secret = runtimeSecret) {
  const sign = (value) =>
    crypto.createHmac("sha256", secret).update(value).digest("hex");
  function read(header = "") {
    const raw = header
      .split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith("bluffx_browser="))
      ?.slice(15);
    if (!raw || !/^[a-f0-9]{32}\.[a-f0-9]{64}$/.test(raw)) return null;
    const [id, signature] = raw.split(".");
    return crypto.timingSafeEqual(
      Buffer.from(signature, "hex"),
      Buffer.from(sign(id), "hex"),
    )
      ? "browser:" + id
      : null;
  }
  return {
    read,
    ensure(req, res, options) {
      const existing = read(req.headers.cookie);
      if (existing) return existing;
      const id = crypto.randomBytes(16).toString("hex");
      res.cookie("bluffx_browser", `${id}.${sign(id)}`, {
        ...options,
        maxAge: 30 * 86400000,
      });
      return "browser:" + id;
    },
  };
}
module.exports = { createRateIdentity };
