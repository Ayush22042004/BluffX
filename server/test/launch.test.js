const test = require("node:test"),
  assert = require("node:assert/strict"),
  crypto = require("node:crypto");
const { supervise } = require("../src/recovery");
const { createRateIdentity } = require("../src/rate-identity");
const { turnConfig } = require("../src/turn");
const { finalResults } = require("../src/results");
const { RoomService } = require("../src/room-service");
const { MemoryGameStore } = require("./memory-game-store.cjs");
const { envelope } = require("../src/protocol");
const { publicState } = require("../src/game");
const { operator, checkInvitation } = require("../src/launch-controls");
const actor = (accountId = crypto.randomUUID()) => ({
  id: crypto.randomUUID(),
  accountId,
  generation: 1,
  profile: { emailVerified: true },
  proposal: crypto.randomBytes(32).toString("hex"),
});
test("ownership supervisor closes a failed generation before constructing a new one", async () => {
  const controller = new AbortController(),
    events = [];
  let n = 0;
  await supervise(
    async () => {
      const id = ++n;
      events.push("start" + id);
      return {
        recovery: id === 1 ? Promise.resolve() : new Promise(() => {}),
        close: async () => events.push("close" + id),
      };
    },
    {
      signal: controller.signal,
      sleep: async () => {},
      onReady: () => {
        if (n === 2) controller.abort();
      },
    },
  );
  assert.deepEqual(events, ["start1", "close1", "start2", "close2"]);
  await assert.rejects(
    supervise(async () => {
      throw Object.assign(Error("schema"), { code: "MIGRATION_REQUIRED" });
    }),
    /schema/,
  );
});
test("signed browser identities separate guests sharing a proxy and reject forged cookies", () => {
  const ids = createRateIdentity(Buffer.alloc(32, 1)),
    cookies = [];
  const res = { cookie: (name, value) => cookies.push(`${name}=${value}`) };
  const a = ids.ensure({ headers: {} }, res, {}),
    b = ids.ensure({ headers: {} }, res, {});
  assert.notEqual(a, b);
  assert.equal(ids.read(cookies[0]), a);
  assert.equal(ids.read(cookies[0].slice(0, -1) + "z"), null);
});
test("Cloudflare TURN credentials stay short lived and never expose the provider token", async () => {
  let sent;
  const config = await turnConfig(
    "seat",
    {
      VOICE_TURN_PROVIDER: "cloudflare",
      CLOUDFLARE_TURN_KEY_ID: "test-key-123",
      CLOUDFLARE_TURN_API_TOKEN: "private-provider-token",
      VOICE_RELAY_ONLY: "true",
    },
    async (url, options) => {
      sent = { url, options };
      return {
        ok: true,
        json: async () => ({
          iceServers: [
            {
              urls: [
                "turn:turn.cloudflare.com:3478?transport=udp",
                "turn:turn.cloudflare.com:53",
              ],
              username: "temporary",
              credential: "temporary-password",
            },
          ],
        }),
      };
    },
  );
  assert.equal(JSON.parse(sent.options.body).ttl, 86400);
  assert.equal(
    sent.options.headers.Authorization,
    "Bearer private-provider-token",
  );
  assert.equal(config.iceTransportPolicy, "relay");
  assert.equal(
    JSON.stringify(config).includes("private-provider-token"),
    false,
  );
  assert.equal(JSON.stringify(config).includes(":53"), false);
  await assert.rejects(
    turnConfig("seat", { VOICE_RELAY_ONLY: "true" }),
    /relay/,
  );
});
test("ranked policy excludes playtests, unverified players and capped outcomes", () => {
  const room = {
    mode: "multiplayer",
    rules: { requireVerifiedRanked: true },
    participants: [
      { id: "a", accountId: "a", emailVerified: true },
      { id: "b", accountId: "b", emailVerified: true },
    ],
    hands: { a: [], b: [{}] },
    winnerId: "a",
  };
  assert.equal(finalResults(room)[0].ranked, true);
  room.participants[1].emailVerified = false;
  assert.equal(finalResults(room)[0].ranked, false);
  room.participants[1].emailVerified = true;
  room.rules.playtestUnranked = true;
  assert.equal(finalResults(room)[0].ranked, false);
  room.rules.playtestUnranked = false;
  room.rankEligibility = false;
  assert.equal(finalResults(room)[0].ranked, false);
});
test("host removal is durable, idempotent, unauthorized-safe and prevents account re-entry", async () => {
  const store = new MemoryGameStore(),
    service = new RoomService(store),
    a = actor(),
    b = actor();
  const { roomId } = await service.create(a, {
    name: "Host",
    maxPlayers: 3,
    actionId: crypto.randomUUID(),
  });
  await service.join(roomId, b, {
    name: "Guest",
    actionId: crypto.randomUUID(),
  });
  const command = (who, event, data = {}) =>
    service.command(roomId, who, event, {
      ...envelope(service.rooms.get(roomId)),
      actionId: crypto.randomUUID(),
      ...data,
    });
  await assert.rejects(
    command(b, "kick_player", { playerId: a.id }),
    (e) => e.code === "NOT_HOST",
  );
  const request = {
    ...envelope(service.rooms.get(roomId)),
    actionId: crypto.randomUUID(),
    playerId: b.id,
  };
  await service.command(roomId, a, "kick_player", request);
  const version = service.rooms.get(roomId).version;
  assert.equal(
    (await service.command(roomId, a, "kick_player", request)).duplicate,
    true,
  );
  assert.equal(service.rooms.get(roomId).version, version);
  await assert.rejects(
    service.join(roomId, actor(b.accountId), {
      name: "Returned",
      actionId: crypto.randomUUID(),
    }),
    (e) => e.code === "ROOM_BANNED",
  );
  assert.equal(
    JSON.stringify(publicState(service.rooms.get(roomId), a.id)).includes(
      b.accountId,
    ),
    false,
  );
  const restored = new RoomService(store);
  await restored.initialize();
  assert.equal(restored.rooms.get(roomId).bannedSeats.length, 1);
});
test("erasing an active account preserves cards, forfeits the seat and scrubs its private profile", async () => {
  const store = new MemoryGameStore(),
    service = new RoomService(store),
    a = actor(),
    b = actor();
  const { roomId } = await service.create(a, {
    name: "Erase This Name",
    maxPlayers: 2,
    actionId: crypto.randomUUID(),
  });
  await service.join(roomId, b, {
    name: "Survivor",
    actionId: crypto.randomUUID(),
  });
  for (const [who, event, data] of [
    [b, "set_ready", { ready: true }],
    [a, "start_game", {}],
  ])
    await service.command(roomId, who, event, {
      ...envelope(service.rooms.get(roomId)),
      actionId: crypto.randomUUID(),
      ...data,
    });
  await service.eraseAccount(a.accountId);
  const state = store.states.get(roomId),
    text = JSON.stringify(state);
  assert.equal(text.includes("Erase This Name"), false);
  assert.equal(text.includes(a.accountId), false);
  assert.equal(state.winnerId, b.id);
  assert.equal(
    [...Object.values(state.hands).flat(), ...state.pile, ...state.discard]
      .length,
    52,
  );
});
test("operator and invite-only gates reject unauthorized callers", () => {
  assert.throws(
    () => operator({ headers: {} }, "x".repeat(32)),
    /authorization/,
  );
  operator(
    { headers: { authorization: "Bearer " + "x".repeat(32) } },
    "x".repeat(32),
  );
  assert.throws(
    () =>
      checkInvitation(null, {
        PLAYTEST_INVITE_ONLY: "true",
        PLAYTEST_ALLOWED_EMAILS: "friend@example.com",
      }),
    /invited/,
  );
  checkInvitation(
    { user: { email: "Friend@example.com", email_verified: 1 } },
    {
      PLAYTEST_INVITE_ONLY: "true",
      PLAYTEST_ALLOWED_EMAILS: "friend@example.com",
    },
  );
});
