const crypto = require("node:crypto");
async function turnConfig(seatId, env = process.env, request = fetch) {
  const iceServers = [
    { urls: env.VOICE_STUN_URL || "stun:stun.cloudflare.com:3478" },
  ];
  if (env.VOICE_TURN_PROVIDER === "cloudflare") {
    if (
      !/^[a-zA-Z0-9_-]{8,128}$/.test(env.CLOUDFLARE_TURN_KEY_ID || "") ||
      !env.CLOUDFLARE_TURN_API_TOKEN
    )
      throw Error("TURN configuration incomplete");
    const response = await request(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.CLOUDFLARE_TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.CLOUDFLARE_TURN_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ttl: 86400 }),
        signal: AbortSignal.timeout(4500),
      },
    );
    if (!response.ok) throw Error("TURN credentials unavailable");
    const data = await response.json();
    if (!Array.isArray(data.iceServers)) throw Error("Invalid TURN response");
    for (const server of data.iceServers.slice(0, 8)) {
      const urls = (
        Array.isArray(server.urls) ? server.urls : [server.urls]
      ).filter(
        (url) =>
          typeof url === "string" &&
          /^(stun|turn|turns):[^\s]{1,200}$/.test(url) &&
          !/:53(?:\?|$)/.test(url),
      );
      if (urls.length)
        iceServers.push({
          urls,
          ...(typeof server.username === "string" &&
          typeof server.credential === "string"
            ? { username: server.username, credential: server.credential }
            : {}),
        });
    }
  } else if (env.VOICE_TURN_URL && env.VOICE_TURN_SECRET) {
    const username = `${Math.floor(Date.now() / 1000) + 86400}:${seatId}`;
    iceServers.push({
      urls: env.VOICE_TURN_URL.split(","),
      username,
      credential: crypto
        .createHmac("sha1", env.VOICE_TURN_SECRET)
        .update(username)
        .digest("base64"),
    });
  }
  const hasRelay = iceServers.some((server) =>
    (Array.isArray(server.urls) ? server.urls : [server.urls]).some((url) =>
      /^turns?:/.test(url),
    ),
  );
  if (env.VOICE_RELAY_ONLY === "true" && !hasRelay)
    throw Error("A relay is required");
  return {
    iceServers,
    iceTransportPolicy: env.VOICE_RELAY_ONLY === "true" ? "relay" : "all",
  };
}
module.exports = { turnConfig };
