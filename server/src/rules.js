function integer(env, key, fallback, min = 1, max = 86400000) {
  if (env[key] === undefined || env[key] === "") return fallback;
  const value = Number(env[key]);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw Error(`Invalid ${key}`);
  return value;
}
function loadRules(env = process.env) {
  for (const name of [
    "PLAYTEST_UNRANKED",
    "PLAYTEST_INVITE_ONLY",
    "RANKED_REQUIRE_VERIFIED",
    "VOICE_RELAY_ONLY",
    "GAME_ADMISSIONS_OPEN",
  ])
    if (env[name] && !["true", "false"].includes(env[name]))
      throw Error(`Invalid ${name}`);
  return Object.freeze({
    graceMs: integer(env, "GAME_GRACE_MS", 10000),
    socketPingIntervalMs: integer(env, "GAME_PING_INTERVAL_MS", 25000, 5000, 30000),
    socketPingTimeoutMs: integer(env, "GAME_PING_TIMEOUT_MS", 20000, 5000, 30000),
    playtestUnranked: env.PLAYTEST_UNRANKED === "true",
    admissionsOpen: env.GAME_ADMISSIONS_OPEN !== "false",
    requireVerifiedRanked: env.RANKED_REQUIRE_VERIFIED !== "false",
    rankedPairDailyLimit: integer(env, "RANKED_PAIR_DAILY_LIMIT", 3, 1, 100),
    aiRounds: integer(env, "GAME_AI_ROUNDS", 3, 1, 10),
    stableRenewalMs: integer(env, "GAME_AI_RENEWAL_MS", 60000, 60000),
    afkStrikes: integer(env, "GAME_AFK_STRIKES", 3, 1, 10),
    resultMs: integer(env, "GAME_RESULT_MS", 10000),
    provisionalMs: integer(env, "GAME_PROVISIONAL_MS", 10000, 1000, 30000),
    maxCards: integer(env, "GAME_MAX_CARDS", 4, 1, 4),
    resumeMs: integer(env, "GAME_RESUME_MS", 86400000, 60000, 604800000),
    retentionMs: integer(env, "GAME_RETENTION_DAYS", 30, 1, 365) * 86400000,
    maxMatchMs: integer(env, "GAME_MAX_MATCH_MS", 21600000, 60000, 86400000),
    actionCache: 512,
    maxPayloadBytes: 8192,
    maxRoomActions: 100000,
    connectionBurst: integer(env, "GAME_CONNECTION_BURST", 30, 2, 500),
    eventBurst: integer(env, "GAME_EVENT_BURST", 40, 4, 500),
    eventRefillPerSec: integer(env, "GAME_EVENT_REFILL", 8, 1, 50),
    setupBurst: integer(env, "GAME_SETUP_BURST", 6, 2, 50),
    setupRefillPerSec: integer(env, "GAME_SETUP_PER_MINUTE", 12, 1, 120) / 60,
    identityBurst: 80,
    identityRefill: 12,
    eventTypeBurst: 20,
    eventTypeRefill: 4,
    httpBurst: 20,
    httpRefill: 2,
    chatBurst: 2,
    chatRefill: 1,
    maxRooms: integer(env, "GAME_MAX_ROOMS", 500, 1, 10000),
    storageTimeoutMs: integer(
      env,
      "GAME_STORAGE_TIMEOUT_MS",
      10000,
      1000,
      60000,
    ),
    storageConnectAttempts: integer(
      env,
      "GAME_STORAGE_CONNECT_ATTEMPTS",
      3,
      1,
      5,
    ),
    gamePoolSize: integer(env, "GAME_POOL_SIZE", 4, 1, 8),
    authPoolSize: integer(env, "AUTH_POOL_SIZE", 2, 1, 5),
    databaseIdleMs: integer(env, "GAME_DB_IDLE_MS", 30000, 1000, 120000),
    poolIdleMs: integer(env, "DB_POOL_IDLE_MS", 10000, 1000, 30000),
    maintenanceMs: integer(env, "DB_MAINTENANCE_MS", 3600000, 60000, 86400000),
    historyLimit: 128,
    finishedMemoryMs: integer(
      env,
      "GAME_FINISHED_MEMORY_MS",
      300000,
      1000,
      3600000,
    ),
    botDelayMs: 2200,
    lobbyExpiryMs: 3600000,
  });
}
module.exports = { loadRules, RULES: loadRules() };
