const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { MemoryGameStore } = require("./memory-game-store.cjs");
const { RoomService, botChoice } = require("../src/room-service");
const { envelope, RateLimiter } = require("../src/protocol");
const { snapshot, finalResults } = require("../src/game-store");
const presence = require("../src/presence");
const { RULES } = require("../src/rules");
const actor = (id = crypto.randomUUID()) => ({
  id,
  generation: 1,
  accountId: null,
  proposal: crypto.randomBytes(32).toString("hex"),
});
async function fixture() {
  let now = 1000000;
  const store = new MemoryGameStore(),
    events = [];
  const service = new RoomService(store, {
    now: () => now,
    onCommit: (r, e) => events.push({ version: r.version, e }),
    random: () => 0.1,
  });
  const a = actor(),
    b = actor();
  const setup = await service.create(a, {
    name: "A",
    maxPlayers: 2,
    turnSeconds: 20,
    actionId: crypto.randomUUID(),
  });
  const code = setup.roomId;
  await service.join(code, b, { name: "B", actionId: crypto.randomUUID() });
  const send = (who, event, data = {}) =>
    service.command(code, who, event, {
      ...envelope(service.rooms.get(code)),
      ...data,
      actionId: data.actionId || crypto.randomUUID(),
    });
  await send(b, "set_ready", { ready: true });
  await send(a, "start_game");
  const seed = async (fn) => {
    const old = service.rooms.get(code),
      r = snapshot(old);
    fn(r);
    await service.save(old, r, null);
  };
  return {
    store,
    service,
    a,
    b,
    code,
    send,
    seed,
    events,
    now: () => now,
    time: (value) => {
      now = value;
    },
    room: () => service.rooms.get(code),
  };
}
test("duplicate acknowledged plays do not write, broadcast or remove cards twice; reuse with different data is rejected", async () => {
  const f = await fixture(),
    r = f.room();
  const data = {
    ...envelope(r),
    cardIds: [r.hands[f.a.id][0].id],
    declaredRank: "J",
    actionId: crypto.randomUUID(),
  };
  const [first, second] = await Promise.all([
    f.service.command(f.code, f.a, "play_cards", data),
    f.service.command(f.code, f.a, "play_cards", data),
  ]);
  assert.equal(second.duplicate, true);
  assert.equal(first.version, second.version);
  assert.equal(f.room().hands[f.a.id].length, 25);
  const writes = f.store.commitCount,
    broadcasts = f.events.length;
  await f.service.command(f.code, f.a, "play_cards", data);
  assert.equal(f.store.commitCount, writes);
  assert.equal(f.events.length, broadcasts);
  await assert.rejects(
    f.service.command(f.code, f.a, "play_cards", {
      ...data,
      declaredRank: "Q",
    }),
    { code: "DUPLICATE_ACTION" },
  );
});
test("stale turn envelopes, malicious ownership, impossible claims and crafted winner events cannot mutate state", async () => {
  const f = await fixture(),
    old = envelope(f.room()),
    first = f.room().hands[f.a.id][0];
  await assert.rejects(
    f.send(f.a, "play_cards", {
      cardIds: f
        .room()
        .hands[f.a.id].slice(0, 5)
        .map((c) => c.id),
      declaredRank: "J",
    }),
    { code: "INVALID_CLAIM" },
  );
  await assert.rejects(
    f.send(f.a, "play_cards", {
      cardIds: [f.room().hands[f.b.id][0].id],
      declaredRank: "J",
    }),
    { code: "INVALID_CLAIM" },
  );
  await assert.rejects(
    f.send({ ...f.a, id: f.b.id }, "play_cards", {
      cardIds: [first.id],
      declaredRank: "J",
    }),
    { code: "NOT_YOUR_TURN" },
  );
  await f.send(f.a, "play_cards", {
    cardIds: [first.id],
    declaredRank: first.rank,
  });
  await assert.rejects(
    f.service.command(f.code, f.a, "pass_bluff", {
      ...old,
      actionId: crypto.randomUUID(),
    }),
    { code: "STALE_TURN" },
  );
  await assert.rejects(f.send(f.a, "submit_victory", { winnerId: f.a.id }), {
    code: "UNKNOWN_ACTION",
  });
  assert.equal(f.room().winnerId, null);
});
test("failed persistence never publishes or installs an uncommitted card play", async () => {
  const f = await fixture(),
    before = snapshot(f.room()),
    events = f.events.length;
  f.store.fail = true;
  await assert.rejects(
    f.send(f.a, "play_cards", {
      cardIds: [before.hands[f.a.id][0].id],
      declaredRank: "J",
    }),
  );
  assert.deepEqual(f.room(), before);
  assert.equal(f.events.length, events);
  f.store.fail = false;
  await f.send(f.a, "play_cards", {
    cardIds: [before.hands[f.a.id][0].id],
    declaredRank: "J",
  });
  assert.equal(f.room().hands[f.a.id].length, 25);
});

test("disconnects during storage failure are retried without restarting their grace deadline", async () => {
  const f = await fixture(),
    before = snapshot(f.room()),
    at = f.now();
  f.store.fail = true;
  await assert.rejects(f.service.disconnect(f.code, f.a));
  assert.deepEqual(f.room(), before);
  f.time(at + 15000);
  f.store.fail = false;
  await f.service.tick();
  const p = f.room().players.find((p) => p.id === f.a.id);
  assert.equal(p.connected, false);
  assert.equal(p.aiTakeover, true);
  assert.equal(p.originalGraceDeadline, at + RULES.graceMs);
  assert.equal(p.graceRemainingMs, 0);
  assert.equal(f.service.pendingDisconnects.size, 0);
});
test("restart restores exact cards, owner and absolute deadline, with fresh secure resume and no new grace", async () => {
  const f = await fixture(),
    before = snapshot(f.room());
  f.time(f.now() + 1000);
  const recovered = new RoomService(f.store, { now: f.now });
  await recovered.initialize();
  const saved = recovered.rooms.get(f.code);
  assert.deepEqual(saved.hands, before.hands);
  assert.equal(saved.turnEndsAt, before.turnEndsAt);
  assert.equal(saved.currentTurnIndex, before.currentTurnIndex);
  assert.equal(saved.pause, null);
  const proposed = crypto.randomBytes(32).toString("hex"),
    resumed = await recovered.resume({ ...f.a, proposal: proposed }, [
      f.a.proposal,
    ]);
  assert.equal(resumed.seatId, f.a.id);
  assert.equal(
    await recovered.resume({ ...f.a, accountId: "attacker" }, [proposed]),
    null,
  );
  assert.equal(
    await recovered.resume(
      { ...f.a, proposal: crypto.randomBytes(32).toString("hex") },
      [f.a.proposal],
    ),
    null,
  );
});
test("challenge commits and result countdown survive restart; automatic/manual advancement races exactly once", async () => {
  const f = await fixture(),
    card = f.room().hands[f.a.id][0];
  await f.send(f.a, "play_cards", {
    cardIds: [card.id],
    declaredRank: card.rank,
  });
  const data = {
    ...envelope(f.room()),
    selectedIndexes: [0],
    actionId: crypto.randomUUID(),
  };
  const [one, two] = await Promise.allSettled([
    f.service.command(f.code, f.b, "call_bluff", data),
    f.service.command(f.code, f.b, "call_bluff", {
      ...data,
      actionId: crypto.randomUUID(),
    }),
  ]);
  assert.equal(one.status, "fulfilled");
  assert.equal(two.reason.code, "STALE_TURN");
  const original = snapshot(f.room());
  const recovered = new RoomService(f.store, { now: f.now });
  await recovered.initialize();
  assert.equal(
    recovered.rooms.get(f.code).resultDeadline,
    original.resultDeadline,
  );
  assert.deepEqual(recovered.rooms.get(f.code).hands, original.hands);
  f.time(original.resultDeadline);
  await recovered.tick();
  assert.equal(recovered.rooms.get(f.code).roundNumber, 2);
  await assert.rejects(
    recovered.command(
      f.code,
      {
        ...f.a,
        generation: recovered.rooms.get(f.code).players[0].controlGeneration,
      },
      "continue_round",
      { ...envelope(original), actionId: crypto.randomUUID() },
    ),
    { code: "STALE_TURN" },
  );
  assert.equal(recovered.rooms.get(f.code).roundNumber, 2);
});
test("five disconnects share one cumulative round grace; brief reconnect never renews AI budget", async () => {
  const f = await fixture();
  let now = f.now();
  for (let i = 0; i < 5; i++) {
    await f.service.disconnect(f.code, f.a);
    f.time(now + 1000);
    const next = crypto.randomBytes(32).toString("hex");
    const info = await f.service.resume({ ...f.a, proposal: next }, [
      f.a.proposal,
    ]);
    f.a.proposal = next;
    f.a.generation = info.generation;
    now += 1000;
  }
  assert.equal(f.room().players[0].graceRemainingMs, 5000);
  await f.seed((r) => {
    r.players[0].aiRoundsUsed = 2;
  });
  await f.service.disconnect(f.code, f.a);
  const next = crypto.randomBytes(32).toString("hex");
  const info = await f.service.resume({ ...f.a, proposal: next }, [
    f.a.proposal,
  ]);
  f.a.generation = info.generation;
  assert.equal(f.room().players[0].aiRoundsUsed, 2);
});
test("connected AFK third missed turn starts one AI controller; meaningful action clears strikes", async () => {
  const f = await fixture();
  for (let n = 0; n < 5; n++) {
    f.time(f.room().turnEndsAt);
    await f.service.tick();
  }
  const p = f.room().players.find((p) => p.id === f.a.id);
  assert.equal(p.afkStrikes, 3);
  assert.equal(p.aiTakeover, true);
  assert.equal(p.controlReason, "afk");
  await assert.rejects(
    f.send(f.a, "play_cards", {
      cardIds: [f.room().hands[f.a.id][0].id],
      declaredRank: "J",
    }),
    { code: "AI_CONTROLLED" },
  );
  await f.send(f.a, "reclaim_control");
  assert.equal(f.room().players[0].afkStrikes, 3);
  await f.seed((r) => {
    r.currentTurnIndex = 0;
    r.turnEndsAt = f.now() + 20000;
  });
  await f.send(f.a, "play_cards", {
    cardIds: [f.room().hands[f.a.id][0].id],
    declaredRank: "J",
  });
  assert.equal(f.room().players[0].afkStrikes, 0);
});

test("AI allowance renews only after sixty continuously connected seconds with meaningful activity", async () => {
  const f = await fixture();
  const r = snapshot(f.room()),
    p = r.players[0],
    start = f.now();
  Object.assign(p, {
    aiRoundsUsed: 2,
    connectedSince: start,
    lastMeaningfulAt: null,
  });
  presence.humanActivity(r, p, start + 59999);
  assert.equal(p.aiRoundsUsed, 2);
  presence.humanActivity(r, p, start + 60000);
  assert.equal(p.aiRoundsUsed, 0);
  Object.assign(p, {
    aiRoundsUsed: 2,
    connectedSince: start + 60000,
    lastMeaningfulAt: null,
  });
  presence.markOffline(r, p.id, start + 120000);
  assert.equal(p.aiRoundsUsed, 2);
});
test("temporary AI finish is provisional, return is unranked, and absence forfeits on a bounded deadline", async () => {
  const f = await fixture();
  await f.seed((r) => {
    const p = r.players[0];
    p.connected = false;
    p.aiTakeover = true;
    p.aiUsed = true;
    p.takeoverRound = 0;
    r.discard.push(...r.hands[p.id].splice(1));
    r.turnEndsAt = f.now() + 20000;
  });
  const system = { ...f.a, system: true };
  const card = f.room().hands[f.a.id][0];
  await f.send(system, "play_cards", {
    cardIds: [card.id],
    declaredRank: card.rank,
  });
  await f.send(f.b, "pass_bluff");
  assert.equal(f.room().phase, "provisional");
  assert.equal(f.room().winnerId, null);
  const deadline = f.room().provisional.deadline;
  const before = snapshot(f.room());
  const returned = await f.service.resume(
    { ...f.a, proposal: crypto.randomBytes(32).toString("hex") },
    [f.a.proposal],
  );
  assert.ok(returned);
  assert.equal(f.room().phase, "finished");
  assert.ok(finalResults(f.room()).every((r) => !r.ranked));
  // Replay the independently saved provisional snapshot in a second test store.
  const other = new MemoryGameStore();
  other.states.set(f.code, before);
  const s = new RoomService(other, { now: () => deadline });
  await s.initialize();
  const waiting = s.rooms.get(f.code);
  // Recovery also disconnected the other survivor: they cannot win while absent.
  assert.equal(waiting.phase, "provisional");
  assert.equal(waiting.provisional.candidateId, f.b.id);
  assert.ok(waiting.participants.find((p) => p.id === f.a.id).forfeit);
  await s.resume({ ...f.b, proposal: crypto.randomBytes(32).toString("hex") }, [
    f.b.proposal,
  ]);
  const final = s.rooms.get(f.code);
  assert.equal(final.winnerId, f.b.id);
  assert.equal(final.winReason, "ai_assisted");
  assert.ok(finalResults(final).every((r) => !r.ranked));
});
test("rate limiter bounds floods and refills without counting client clocks", () => {
  let now = 0;
  const l = new RateLimiter(() => now);
  for (let i = 0; i < 40; i++) l.consume("s");
  assert.throws(() => l.consume("s"), { code: "RATE_LIMITED" });
  now = 1000;
  for (let i = 0; i < 8; i++) l.consume("s");
  assert.throws(() => l.consume("s"), { code: "RATE_LIMITED" });
});

test("AI decisions are invariant to opponents' hidden card values", async () => {
  const f = await fixture();
  await f.send(f.a, "play_cards", {
    cardIds: [f.room().hands[f.a.id][0].id],
    declaredRank: "J",
  });
  const r = snapshot(f.room()),
    p = r.players[1];
  const before = botChoice(r, p, () => 0.1);
  r.hands[f.a.id] = r.hands[f.a.id].map((c) => ({
    ...c,
    rank: "Q",
    suit: "H",
  }));
  r.lastMove.cards = r.lastMove.cards.map((c) => ({
    ...c,
    rank: "A",
    suit: "D",
  }));
  assert.deepEqual(
    botChoice(r, p, () => 0.1),
    before,
  );
});

test("a disconnected last survivor also needs bounded provisional resolution", async () => {
  const f = await fixture();
  await f.seed((r) => {
    r.players[0].connected = false;
  });
  await f.send(f.b, "leave_room");
  assert.equal(f.room().phase, "provisional");
  assert.equal(f.room().winnerId, null);
  f.time(f.room().provisional.deadline);
  await f.service.tick();
  assert.equal(f.service.rooms.has(f.code), false);
  assert.ok([...f.store.results.values()].flat().every((r) => !r.ranked));
});
module.exports = { fixture, actor };
