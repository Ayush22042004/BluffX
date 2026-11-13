const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { RoomService, integrity } = require("../src/room-service");
const { MemoryGameStore } = require("./memory-game-store.cjs");
const { envelope } = require("../src/protocol");
const { snapshot } = require("../src/game-store");
const presence = require("../src/presence");
const { DeadlineScheduler } = require("../src/deadline-scheduler");
const { RoomDelivery } = require("../src/room-delivery");
const { applyRoomPatch } = require("../../client/src/lib/room-state.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fixture() {
  let now = Date.now();
  const store = new MemoryGameStore();
  const service = new RoomService(store, { now: () => now, random: () => 0.6 });
  const seats = Array.from({ length: 3 }, () => ({
    id: crypto.randomUUID(),
    accountId: null,
    generation: 1,
    proposal: crypto.randomBytes(32).toString("hex"),
  }));
  const created = await service.create(seats[0], {
    name: "A",
    maxPlayers: 3,
    turnSeconds: 20,
    actionId: crypto.randomUUID(),
  });
  const code = created.roomId;
  for (const [i, p] of seats.entries())
    if (i)
      await service.join(code, p, {
        name: "P" + i,
        actionId: crypto.randomUUID(),
      });
  const room = () => service.rooms.get(code),
    send = (p, event, data = {}) =>
      service.command(code, p, event, {
        ...envelope(room()),
        actionId: crypto.randomUUID(),
        ...data,
      });
  for (const p of seats.slice(1)) await send(p, "set_ready", { ready: true });
  await send(seats[0], "start_game");
  const seed = async (fn) => {
    const before = room(),
      r = snapshot(before);
    fn(r);
    await service.save(before, r, null);
  };
  const expire = async (seat) => {
    await seed((r) => {
      r.currentTurnIndex = r.players.findIndex((p) => p.id === seat.id);
      r.turnSequence++;
      r.turnEndsAt = now + 20000;
    });
    now = room().turnEndsAt;
    await service.tick();
  };
  return {
    store,
    service,
    seats,
    code,
    room,
    send,
    seed,
    expire,
    time: (x) => (now = x),
    now: () => now,
    p: () => room().players[0],
  };
}
test("AFK warnings progress once per eligible expiry, with no grace or hand replacement at strike three", async () => {
  const f = await fixture(),
    a = f.seats[0],
    hand = snapshot(f.room().hands[a.id]);
  await f.expire(a);
  assert.equal(f.p().controllerState, "HUMAN_AFK_WARNING");
  assert.equal(f.p().afkStrikes, 1);
  assert.equal(f.p().aiTakeover, false);
  await f.service.tick();
  assert.equal(f.p().afkStrikes, 1);
  await f.expire(a);
  assert.equal(f.p().controllerState, "HUMAN_AFK_FINAL_WARNING");
  assert.match(f.room().presenceEvents.at(-1).message, /One more missed turn/);
  await f.expire(a);
  assert.equal(f.p().controllerState, "AI_CONTROLLING");
  assert.equal(f.p().controlReason, "afk");
  assert.equal(f.room().pause, null);
  assert.ok(!f.p().graceUntil);
  assert.deepEqual(f.room().hands[a.id], hand);
});
test("only voluntary legal gameplay clears AFK warnings; invalid and AI actions do not", async () => {
  const f = await fixture(),
    a = f.seats[0];
  await f.expire(a);
  await assert.rejects(
    f.send(a, "play_cards", { cardIds: ["fake"], declaredRank: "J" }),
  );
  assert.equal(f.p().afkStrikes, 1);
  await f.seed((r) => {
    r.currentTurnIndex = 0;
    r.turnEndsAt = f.now() + 20000;
  });
  await f.send(a, "play_cards", {
    cardIds: [f.room().hands[a.id][0].id],
    declaredRank: "J",
  });
  assert.equal(f.p().afkStrikes, 0);
  await f.seed((r) => {
    r.currentTurnIndex = 0;
    r.turnEndsAt = f.now() + 20000;
    r.players[0].aiTakeover = true;
    r.players[0].aiUsed = true;
    r.players[0].afkStrikes = 3;
    r.players[0].takeoverAt = f.now();
    r.players[0].takeoverRound = r.completedRounds;
  });
  await f.send({ ...a, system: true }, "play_cards", {
    cardIds: [f.room().hands[a.id][0].id],
    declaredRank: "J",
  });
  assert.equal(f.p().afkStrikes, 3);
});
test("authorized reclaim preserves current cards, timer, AI usage and strikes until a human action", async () => {
  const f = await fixture(),
    a = f.seats[0];
  await f.seed((r) => {
    Object.assign(r.players[0], {
      aiTakeover: true,
      aiUsed: true,
      afkStrikes: 3,
      controlReason: "afk",
      aiRoundsUsed: 1,
      takeoverRound: r.completedRounds,
      takeoverAt: f.now(),
    });
  });
  const before = snapshot(f.room());
  await f.send(a, "reclaim_control");
  assert.equal(f.p().aiTakeover, false);
  assert.equal(f.p().aiRoundsUsed, 1);
  assert.equal(f.p().afkStrikes, 3);
  assert.equal(f.room().turnEndsAt, before.turnEndsAt);
  assert.deepEqual(f.room().hands, before.hands);
  await f.send(a, "play_cards", {
    cardIds: [f.room().hands[a.id][0].id],
    declaredRank: "J",
  });
  assert.equal(f.p().afkStrikes, 0);
});
test("disconnect in warning retains strikes and cumulative grace across secure reconnection", async () => {
  const f = await fixture(),
    a = f.seats[0];
  await f.expire(a);
  await f.service.disconnect(f.code, a);
  assert.equal(f.p().controllerState, "OFFLINE_GRACE");
  assert.equal(f.p().afkStrikes, 1);
  f.time(f.now() + 2000);
  const next = crypto.randomBytes(32).toString("hex");
  await f.service.resume({ ...a, proposal: next }, [a.proposal]);
  assert.equal(f.p().afkStrikes, 1);
  assert.equal(f.p().graceRemainingMs, 8000);
  assert.equal(f.p().controllerState, "HUMAN_AFK_WARNING");
});
test("disconnect during AFK AI control does not add a pause, grace or second allowance", async () => {
  const f = await fixture(),
    a = f.seats[0];
  await f.seed((r) => {
    Object.assign(r.players[0], {
      aiTakeover: true,
      aiUsed: true,
      controlReason: "afk",
      afkStrikes: 3,
      aiRoundsUsed: 1,
      takeoverRound: 0,
      takeoverAt: f.now(),
    });
    r.completedRounds = 1;
  });
  const before = f.room().turnEndsAt;
  await f.service.disconnect(f.code, a);
  assert.equal(f.p().controllerState, "AI_CONTROLLING");
  assert.equal(f.p().aiRoundsUsed, 2);
  assert.equal(f.p().controlReason, "afk");
  assert.equal(f.room().turnEndsAt, before);
  assert.equal(f.room().pause, null);
  assert.ok(!f.p().graceUntil);
  await f.service.disconnect(f.code, a);
  assert.equal(f.p().aiRoundsUsed, 2);
});
test("simultaneous eligible timeout and disconnect have the same no-extra-grace outcome in both orders", async () => {
  for (const reverse of [false, true]) {
    const f = await fixture(),
      a = f.seats[0];
    await f.seed((r) => {
      r.players[0].afkStrikes = 2;
    });
    const deadline = f.room().turnEndsAt;
    f.time(deadline);
    const jobs = [
      () => f.service.tick(),
      () => f.service.disconnect(f.code, a),
    ];
    if (reverse) jobs.reverse();
    await Promise.all(jobs.map((fn) => fn()));
    assert.equal(f.p().afkStrikes, 3);
    assert.equal(f.p().controllerState, "AI_CONTROLLING");
    assert.equal(f.room().pause, null);
    assert.equal(f.room().turnEndsAt, deadline + 20000);
    assert.ok(!f.p().graceUntil);
    integrity(f.room());
  }
});
test("AFK AI and deliberate reclaim serialize: at most one AI action and no reset of a running clock", async () => {
  for (const reverse of [false, true]) {
    const f = await fixture(),
      a = f.seats[0];
    await f.seed((r) => {
      Object.assign(r.players[0], {
        aiTakeover: true,
        aiUsed: true,
        controlReason: "afk",
        takeoverAt: f.now(),
        takeoverRound: 0,
        afkStrikes: 3,
      });
    });
    const due = f.room().botDueAt,
      deadline = f.room().turnEndsAt;
    f.time(due);
    const jobs = [() => f.service.tick(), () => f.send(a, "reclaim_control")];
    if (reverse) jobs.reverse();
    await Promise.all(jobs.map((fn) => fn()));
    assert.equal(f.p().aiTakeover, false);
    const ai = (f.room().playHistory || []).filter((x) => x.ai);
    assert.ok(ai.length <= 1);
    assert.equal(
      f.room().hands[a.id].length,
      18 - (ai[0]?.cardIds.length || 0),
    );
    assert.equal(f.room().turnEndsAt, ai.length ? due + 20000 : deadline);
    integrity(f.room());
  }
});
test("AI takeover persists through restart, with no duplicate expired strike or extra AI budget", async () => {
  const f = await fixture(),
    a = f.seats[0];
  await f.expire(a);
  await f.expire(a);
  await f.expire(a);
  const before = snapshot(f.room());
  const s = new RoomService(f.store, { now: f.now });
  await s.initialize();
  const r = s.rooms.get(f.code),
    p = r.players.find((x) => x.id === a.id);
  assert.equal(p.controllerState, "AI_CONTROLLING");
  assert.equal(p.afkStrikes, 3);
  assert.equal(p.controlReason, "afk");
  assert.equal(p.aiRoundsUsed, before.players[0].aiRoundsUsed);
  assert.deepEqual(r.hands, before.hands);
  assert.equal(r.turnEndsAt, before.turnEndsAt);
});
test("fresh actions avoid receipt reads; old acknowledged retries remain durable and malicious ID reuse rolls back", async () => {
  const f = await fixture(),
    a = f.seats[0];
  let lookups = 0;
  const read = f.store.receipt.bind(f.store);
  f.store.receipt = (...args) => {
    lookups++;
    return read(...args);
  };
  const data = {
    ...envelope(f.room()),
    actionId: crypto.randomUUID(),
    cardIds: [f.room().hands[a.id][0].id],
    declaredRank: "J",
  };
  await f.service.command(f.code, a, "play_cards", data);
  assert.equal(lookups, 0);
  const writes = f.store.commitCount;
  f.service.receipts.clear();
  assert.equal(
    (await f.service.command(f.code, a, "play_cards", data)).duplicate,
    true,
  );
  assert.equal(f.store.commitCount, writes);
  await assert.rejects(f.send(a, "pass_bluff", { actionId: data.actionId }), {
    code: "DUPLICATE_ACTION",
  });
  assert.equal(f.store.commitCount, writes);
});
test("incremental delivery omits unchanged private hands and enforces ordered patches and safe legacy snapshots", async () => {
  const f = await fixture(),
    d = new RoomDelivery();
  const sockets = f.seats.slice(0, 2).map((p) => ({
    data: { playerId: p.id },
    handshake: { auth: { stateProtocol: 2 } },
    events: [],
    emit(event, value) {
      this.events.push({ event, value });
    },
  }));
  d.prepare(f.room());
  for (const s of sockets) d.full(s, f.room());
  const initial = sockets.map((s) => s.events[0].value);
  const secret = f.room().hands[f.seats[0].id][0].id;
  await f.send(f.seats[0], "play_cards", {
    cardIds: [secret],
    declaredRank: "J",
  });
  const prep = d.prepare(f.room());
  for (const s of sockets) d.send(s, f.room(), prep);
  const patches = sockets.map((s) => s.events.at(-1).value);
  assert.equal(sockets[0].events.at(-1).event, "room_patch");
  assert.equal(patches[0].hand.length, 17);
  assert.ok(!Object.hasOwn(patches[1], "hand"));
  assert.ok(!JSON.stringify(patches[1]).includes(secret));
  assert.equal(patches[1].changes.hands, undefined);
  assert.equal(patches[1].changes.players?.[0].resumeHash, undefined);
  assert.equal(
    applyRoomPatch(initial[0], patches[0]).version,
    f.room().version,
  );
  assert.equal(applyRoomPatch({ ...initial[0], version: 0 }, patches[0]), null);
  const count = sockets[0].events.length;
  d.send(sockets[0], f.room(), prep);
  assert.equal(sockets[0].events.length, count);
  sockets[1].handshake.auth.stateProtocol = 1;
  delete sockets[1].data.stateVersion;
  d.send(sockets[1], f.room(), prep);
  assert.equal(sockets[1].events.at(-1).event, "room_state");
  assert.equal(sockets[1].events.at(-1).value.hand.length, 17);
});
test("indexed deadline scheduler has one timer, bounded concurrency, no orphan entries and no idle wakes", async () => {
  let now = 1000,
    max = 0;
  const scheduler = new DeadlineScheduler(
    async (id) => {
      max = Math.max(max, scheduler.running.size);
      await sleep(1);
      scheduler.set(id, null);
    },
    { now: () => now, concurrency: 2 },
  );
  for (let i = 0; i < 50; i++) scheduler.set("r" + i, 2000 + i);
  for (let i = 0; i < 500; i++) scheduler.set("r0", 2000 + i);
  assert.equal(scheduler.heap.length, 50);
  assert.equal(scheduler.positions.size, 50);
  assert.ok(scheduler.timer);
  now = 3000;
  scheduler.flush();
  for (
    let i = 0;
    i < 200 && scheduler.running.size + scheduler.heap.length;
    i++
  )
    await sleep(2);
  assert.equal(max, 2);
  assert.equal(scheduler.heap.length, 0);
  assert.equal(scheduler.running.size, 0);
  const wakes = scheduler.wakeups;
  await sleep(20);
  assert.equal(scheduler.wakeups, wakes);
  scheduler.close();
  assert.equal(scheduler.timer, null);
  assert.equal(scheduler.positions.size, 0);
});
test("finished-room cleanup retires hands and scheduler state without changing official results", async () => {
  const f = await fixture();
  await f.send(f.seats[1], "leave_room");
  await f.send(f.seats[2], "leave_room");
  assert.equal(f.room().phase, "finished");
  const results = snapshot([...f.store.results.values()]);
  f.time(f.room().nextWakeAt);
  await f.service.tick();
  assert.equal(f.service.rooms.has(f.code), false);
  assert.deepEqual([...f.store.results.values()], results);
});

test("normalized warning metadata respects a recovered room-specific AFK threshold", async () => {
  const f = await fixture();
  await f.seed((r) => {
    r.rules.afkStrikes = 4;
    r.players[0].afkStrikes = 2;
  });
  assert.equal(f.p().controllerState, "HUMAN_AFK_WARNING");
  await f.seed((r) => {
    r.players[0].afkStrikes = 3;
  });
  assert.equal(f.p().controllerState, "HUMAN_AFK_FINAL_WARNING");
});
