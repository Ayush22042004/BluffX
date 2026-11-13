const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  clockwiseSeats,
  opponentPosition,
} = require("../../client/src/lib/seating.js");
const { MemoryGameStore } = require("./memory-game-store.cjs");
const { RoomService } = require("../src/room-service");
const { publicState } = require("../src/game");
const { envelope } = require("../src/protocol");
test("every local seat rotates the same authoritative turn order without changing server seat numbers", () => {
  for (let n = 2; n <= 6; n++) {
    const players = Array.from({ length: n }, (_, i) => ({
      id: "seat" + i,
      seatNumber: i + 1,
    }));
    for (let own = 0; own < n; own++) {
      const rotated = clockwiseSeats(players, players[own].id);
      assert.equal(rotated[0], players[own]);
      assert.deepEqual(
        rotated.map((p) => p.seatNumber),
        Array.from({ length: n }, (_, k) => ((own + k) % n) + 1),
      );
      let angle = 90;
      for (let i = 0; i < n - 1; i++) {
        const p = opponentPosition(n, i),
          x = parseFloat(p["--seat-x"]) - 50,
          y = parseFloat(p["--seat-y"]) - 40;
        let next = (Math.atan2(y, x) * 180) / Math.PI;
        while (next <= angle) next += 360;
        assert.ok(next < 450);
        angle = next;
      }
    }
  }
});
test("profile metadata follows the authorized seat across a turn change without moving cards or extending time", async () => {
  const store = new MemoryGameStore(),
    service = new RoomService(store),
    actor = {
      id: crypto.randomUUID(),
      generation: 1,
      proposal: crypto.randomBytes(32).toString("hex"),
    };
  const { roomId } = await service.create(
    actor,
    { name: "Human", botCount: 2, actionId: crypto.randomUUID() },
    true,
  );
  let room = service.rooms.get(roomId);
  await service.command(roomId, actor, "start_game", {
    ...envelope(room),
    actionId: crypto.randomUUID(),
  });
  room = service.rooms.get(roomId);
  const old = envelope(room);
  await service.command(roomId, actor, "play_cards", {
    ...old,
    actionId: crypto.randomUUID(),
    cardIds: [room.hands[actor.id][0].id],
    declaredRank: "J",
  });
  const before = service.rooms.get(roomId),
    deadline = before.turnEndsAt,
    hands = JSON.stringify(before.hands),
    avatarId = crypto.randomUUID();
  await service.command(roomId, actor, "update_profile", {
    ...old,
    actionId: crypto.randomUUID(),
    name: "New Name",
    avatar: 2,
    avatarId,
  });
  room = service.rooms.get(roomId);
  assert.equal(room.players[0].avatarId, avatarId);
  assert.equal(room.players[0].name, "New Name");
  assert.equal(room.turnEndsAt, deadline);
  assert.equal(JSON.stringify(room.hands), hands);
});
test("new and recovered AI seats are numbered Bot 1 onward, and public seats match turn indices", async () => {
  const store = new MemoryGameStore(),
    service = new RoomService(store),
    actor = {
      id: crypto.randomUUID(),
      generation: 1,
      proposal: crypto.randomBytes(32).toString("hex"),
    };
  const { roomId } = await service.create(
    actor,
    { name: "Human", botCount: 5, actionId: crypto.randomUUID() },
    true,
  );
  let room = service.rooms.get(roomId);
  assert.deepEqual(
    room.players.slice(1).map((p) => p.name),
    ["Bot 1", "Bot 2", "Bot 3", "Bot 4", "Bot 5"],
  );
  assert.deepEqual(
    publicState(room, actor.id).players.map((p) => p.seatNumber),
    [1, 2, 3, 4, 5, 6],
  );
  const before = room;
  const clone = JSON.parse(JSON.stringify(room));
  clone.players[1].name = "Legacy random name";
  await service.save(before, clone, null);
  const restored = new RoomService(store);
  await restored.initialize();
  room = restored.rooms.get(roomId);
  assert.equal(room.players[1].name, "Bot 1");
  assert.equal(room.players[0].name, "Human");
});
