const test = require("node:test"),
  assert = require("node:assert/strict"),
  crypto = require("node:crypto");
const game = require("../src/game");
const { RoomService, integrity } = require("../src/room-service");
const { MemoryGameStore } = require("./memory-game-store.cjs");
const { envelope } = require("../src/protocol");
const { recommendDecks, validateSettings } = require("../src/setup");
const actor = () => ({
  id: crypto.randomUUID(),
  generation: 1,
  proposal: crypto.randomBytes(32).toString("hex"),
});
for (const deckCount of [1, 2])
  test(`${deckCount} decks support ten humans, unique cards, removal and recovery`, async () => {
    const store = new MemoryGameStore(),
      service = new RoomService(store);
    const people = Array.from({ length: 10 }, actor),
      host = people[0];
    const { roomId } = await service.create(host, {
      name: "Host",
      maxPlayers: 10,
      deckCount,
      actionId: crypto.randomUUID(),
    });
    for (const [i, p] of people.slice(1).entries())
      await service.join(roomId, p, {
        name: `Player ${i}`,
        actionId: crypto.randomUUID(),
      });
    await assert.rejects(
      service.join(roomId, actor(), {
        name: "Extra",
        actionId: crypto.randomUUID(),
      }),
    );
    const send = (p, e, d = {}) =>
      service.command(roomId, p, e, {
        ...envelope(service.rooms.get(roomId)),
        actionId: crypto.randomUUID(),
        ...d,
      });
    for (const p of people.slice(1))
      await send(p, "set_ready", { ready: true });
    await send(host, "start_game");
    const room = service.rooms.get(roomId),
      cards = Object.values(room.hands).flat();
    assert.equal(cards.length, 52 * deckCount);
    assert.equal(new Set(cards.map((c) => c.id)).size, cards.length);
    assert.equal(new Set(cards.map((c) => c.rank + c.suit)).size, 52);
    await send(people[4], "leave_room");
    assert.equal(
      Object.values(service.rooms.get(roomId).hands).flat().length +
        service.rooms.get(roomId).discard.length,
      52 * deckCount,
    );
    const recovered = new RoomService(store);
    await recovered.initialize();
    assert.deepEqual(
      recovered.rooms.get(roomId).hands,
      service.rooms.get(roomId).hands,
    );
  });
test("deck recommendations never overwrite explicit choices; invalid setup is rejected", () => {
  assert.equal(recommendDecks(5), 1);
  assert.equal(recommendDecks(6), 2);
  assert.equal(
    validateSettings({ preset: "party", deckCount: 1 }).deckCount,
    1,
  );
  for (const data of [
    { deckCount: 3 },
    { maxPlayers: 11 },
    { voiceEnabled: "yes" },
    { aiStyle: "cheat" },
  ])
    assert.throws(() => validateSettings(data));
});
test("new rematch lobby preserves seats, demands readiness and starts a fresh identity/deck", async () => {
  const service = new RoomService(new MemoryGameStore()),
    a = actor();
  const { roomId } = await service.create(
    a,
    { name: "A", botCount: 1, actionId: crypto.randomUUID() },
    true,
  );
  const send = (e, d = {}) =>
    service.command(roomId, a, e, {
      ...envelope(service.rooms.get(roomId)),
      actionId: crypto.randomUUID(),
      ...d,
    });
  await send("start_game");
  const old = service.rooms.get(roomId),
    oldMatch = old.matchId,
    oldCards = Object.values(old.hands)
      .flat()
      .map((c) => c.id);
  game.finishGame(old, a.id, Date.now(), true);
  await send("prepare_rematch");
  assert.equal(service.rooms.get(roomId).phase, "lobby");
  assert.equal(service.rooms.get(roomId).players[0].ready, false);
  await assert.rejects(send("start_game"), /ready/);
  await send("set_ready", { ready: true });
  await send("start_game");
  assert.notEqual(service.rooms.get(roomId).matchId, oldMatch);
  assert.ok(
    Object.values(service.rooms.get(roomId).hands)
      .flat()
      .every((c) => !oldCards.includes(c.id)),
  );
});
test("rematch clears completed-match AFK control and does not renew exhausted offline grace", async () => {
  const service = new RoomService(new MemoryGameStore()),
    a = actor(),
    b = actor();
  const { roomId } = await service.create(a, {
    name: "Host",
    maxPlayers: 2,
    actionId: crypto.randomUUID(),
  });
  await service.join(roomId, b, {
    name: "Human",
    actionId: crypto.randomUUID(),
  });
  const send = (p, event, data = {}) =>
    service.command(roomId, p, event, {
      ...envelope(service.rooms.get(roomId)),
      actionId: crypto.randomUUID(),
      ...data,
    });
  await send(b, "set_ready", { ready: true });
  await send(a, "start_game");
  let r = service.rooms.get(roomId);
  game.finishGame(r, a.id, Date.now(), true);
  r.players[1].aiTakeover = true;
  r.players[1].controlReason = "afk";
  r.players[1].afkStrikes = 3;
  await send(a, "prepare_rematch");
  r = service.rooms.get(roomId);
  assert.equal(r.players[1].aiTakeover, false);
  assert.equal(r.players[1].ready, false);
  await send(b, "set_ready", { ready: true });
  await send(a, "set_ready", { ready: true });
  await send(a, "start_game");
  r = service.rooms.get(roomId);
  game.finishGame(r, a.id, Date.now(), true);
  Object.assign(r.players[1], {
    connected: false,
    aiTakeover: true,
    graceRemainingMs: 0,
    graceUntil: null,
  });
  await send(a, "prepare_rematch");
  assert.equal(service.rooms.get(roomId).players.length, 1);
});
