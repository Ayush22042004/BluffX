const crypto = require("node:crypto");
const { error } = require("./game-store");
const { RULES } = require("./rules");
const UUID = /^[a-zA-Z0-9_-]{8,100}$/;
const REQUEST_FP = Symbol("trusted request fingerprint");
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    );
  return value;
}
function fingerprint(event, data) {
  if (data?.[REQUEST_FP]) return data[REQUEST_FP];
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical({ event, data })))
    .digest("hex");
}
function envelope(room) {
  return {
    stateVersion: room.version,
    matchId: room.matchId || null,
    roundSequence: room.roundNumber,
    roundId: room.roundId || null,
    turnSequence: room.turnSequence || 0,
    claimSequence: room.claimSequence || 0,
  };
}
function validateEnvelope(room, data) {
  if (!data || !UUID.test(data.actionId || ""))
    throw error("INVALID_ACTION", "An actionId is required.");
  if (
    data.matchId !== (room.matchId || null) ||
    data.roundSequence !== room.roundNumber ||
    data.roundId !== (room.roundId || null)
  )
    throw error("STALE_TURN", "The match or round has changed.");
  if (data.turnSequence !== (room.turnSequence || 0))
    throw error("STALE_TURN", "The active turn has changed.");
  if (data.claimSequence !== (room.claimSequence || 0))
    throw error("INVALID_CLAIM", "That claim has closed.");
}
function validatePayload(data, event) {
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    Buffer.byteLength(JSON.stringify(data)) > RULES.maxPayloadBytes
  )
    throw error("INVALID_PAYLOAD", "Invalid or oversized event payload.");
  if (
    Object.keys(data).some((k) =>
      ["__proto__", "constructor", "prototype"].includes(k),
    )
  )
    throw error("INVALID_PAYLOAD", "Unsafe payload.");
  const fields = {
    create_room: [
      "name",
      "avatar",
      "avatarId",
      "deckCount",
      "preset",
      "voiceEnabled",
      "aiStyle",
      "maxPlayers",
      "botCount",
      "turnSeconds",
      "roomName",
      "password",
    ],
    create_ai_room: [
      "name",
      "avatar",
      "avatarId",
      "deckCount",
      "preset",
      "voiceEnabled",
      "aiStyle",
      "maxPlayers",
      "botCount",
      "turnSeconds",
      "roomName",
      "password",
    ],
    join_room: ["name", "avatar", "avatarId", "password"],
    set_ready: ["ready"],
    update_settings: [
      "maxPlayers",
      "deckCount",
      "turnSeconds",
      "voiceEnabled",
      "preset",
      "aiStyle",
    ],
    play_cards: ["cardIds", "declaredRank"],
    call_bluff: ["selectedIndexes", "claimTs"],
    update_profile: ["name", "avatar", "avatarId"],
    send_chat: ["text"],
    kick_player: ["playerId"],
  };
  if (event) {
    const allowed = new Set([
      "stateVersion",
      "actionId",
      "roomId",
      "matchId",
      "roundId",
      "roundSequence",
      "turnSequence",
      "claimSequence",
      ...(fields[event] || []),
    ]);
    if (Object.keys(data).some((key) => !allowed.has(key)))
      throw error("INVALID_PAYLOAD", "Unexpected event fields.");
  }
}
class RateLimiter {
  constructor(now = Date.now) {
    this.entries = new Map();
    this.now = now;
    this.nextSweep = 0;
  }
  consume(key, capacity = RULES.eventBurst, refill = RULES.eventRefillPerSec) {
    const now = this.now();
    if (this.entries.size >= 20000 && now >= this.nextSweep) {
      this.nextSweep = now + 60000;
      for (const [id, e] of this.entries)
        if (now - e.at > 600000) this.entries.delete(id);
    }
    if (!this.entries.has(key) && this.entries.size >= 20000)
      throw Object.assign(
        error(
          "RATE_LIMITED",
          "Server request capacity reached. Try again shortly.",
        ),
        { retryAfterMs: 60000 },
      );
    const old = this.entries.get(key) || { tokens: capacity, at: now };
    const tokens = Math.min(
      capacity,
      old.tokens + (Math.max(0, now - old.at) * refill) / 1000,
    );
    this.entries.set(key, {
      tokens: tokens >= 1 ? tokens - 1 : tokens,
      at: now,
    });
    if (tokens < 1)
      throw Object.assign(
        error("RATE_LIMITED", "Too many requests. Wait before retrying."),
        { retryAfterMs: Math.ceil(((1 - tokens) * 1000) / refill) },
      );
  }
}
module.exports = {
  REQUEST_FP,
  canonical,
  fingerprint,
  envelope,
  validateEnvelope,
  validatePayload,
  RateLimiter,
};
