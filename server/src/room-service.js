const crypto = require("node:crypto");
const game = require("./game");
const presence = require("./presence");
const { RULES } = require("./rules");
const { error, snapshot } = require("./game-store");
const { fingerprint, envelope, validateEnvelope } = require("./protocol");
const { validAvatarId } = require("./avatars");
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const active = (r) =>
  ["playing", "round_result", "provisional"].includes(r.phase);
function integrity(r) {
  if (
    !r ||
    r.schemaVersion !== 1 ||
    !Number.isSafeInteger(r.version) ||
    !Array.isArray(r.players) ||
    r.players.length > 10 ||
    new Set(r.players.map((p) => p.id)).size !== r.players.length
  )
    throw error("CORRUPT_SNAPSHOT", "Invalid stored room metadata.");
  if (r.matchId) {
    const cards = [...Object.values(r.hands).flat(), ...r.pile, ...r.discard];
    const deckCount = r.deckCount ?? 1;
    const faces = new Map();
    for (const c of cards)
      faces.set(
        c.rank + ":" + c.suit,
        (faces.get(c.rank + ":" + c.suit) || 0) + 1,
      );
    if (
      ![1, 2].includes(deckCount) ||
      cards.length !== 52 * deckCount ||
      new Set(cards.map((c) => c.id)).size !== 52 * deckCount ||
      faces.size !== 52 ||
      [...faces.values()].some((n) => n !== deckCount) ||
      cards.some(
        (c) =>
          !["S", "H", "D", "C"].includes(c.suit) ||
          ![
            "A",
            "2",
            "3",
            "4",
            "5",
            "6",
            "7",
            "8",
            "9",
            "10",
            "J",
            "Q",
            "K",
          ].includes(c.rank),
      )
    )
      throw error("CORRUPT_SNAPSHOT", "The stored deck failed validation.");
    if (
      r.players.length &&
      (!Number.isInteger(r.currentTurnIndex) || !r.players[r.currentTurnIndex])
    )
      throw error("CORRUPT_SNAPSHOT", "Invalid turn owner.");
  }
}
function synchronize(r) {
  let bot = 0;
  for (const p of r.players) {
    if (p.isBot) p.name = `Bot ${++bot}`;
    presence.syncController(p, r.rules?.afkStrikes);
    const saved = r.participants?.find((x) => x.id === p.id);
    if (saved)
      Object.assign(saved, {
        aiUsed: !!p.aiUsed,
        calls: p.calls || 0,
        correctCalls: p.correctCalls || 0,
        name: p.name,
        avatar: p.avatar,
        avatarId: p.avatarId || null,
      });
  }
}
function botChoice(r, p, random = Math.random) {
  // Intentionally sees only its own hand and the public claim's count/rank.
  const style =
    require("./setup").AI_STYLES[r.aiStyle] ||
    require("./setup").AI_STYLES.balanced;
  const hand = r.hands[p.id],
    claim = r.lastMove;
  if (claim && (r.pendingWinnerId || random() < style.respond)) {
    if (random() < style.challenge) {
      const count = Math.max(1, Math.floor(claim.cards.length / 2));
      return {
        event: "call_bluff",
        data: { selectedIndexes: Array.from({ length: count }, (_, i) => i) },
      };
    }
    return { event: "pass_bluff", data: {} };
  }
  const matching = hand.filter((c) => c.rank === r.roundRank);
  if (claim && !matching.length && random() < style.pass)
    return { event: "pass_bluff", data: {} };
  const pool =
    r.roundRank && random() < style.truth && matching.length ? matching : hand;
  const chosen = pool.slice(
    0,
    Math.min(pool.length, r.rules.maxCards, 1 + Math.floor(random() * 3)),
  );
  return {
    event: "play_cards",
    data: {
      cardIds: chosen.map((c) => c.id),
      declaredRank: r.roundRank || chosen[0].rank,
    },
  };
}
class RoomService {
  constructor(
    store,
    {
      now = Date.now,
      random = Math.random,
      rules = RULES,
      onCommit = () => {},
    } = {},
  ) {
    this.store = store;
    this.now = now;
    this.random = random;
    this.rules = rules;
    this.onCommit = onCommit;
    this.rooms = new Map();
    this.queues = new Map();
    this.receipts = new Map();
    this.reloadNeeded = new Set();
    this.retryAt = new Map();
    this.pendingDisconnects = new Map();
    this.stopping = false;
    this.onSchedule = () => {};
    this.metrics = { start: () => 0, end: () => {} };
  }
  queue(code, work) {
    const next = (this.queues.get(code) || Promise.resolve())
      .catch(() => {})
      .then(work);
    this.queues.set(code, next);
    next
      .finally(() => {
        if (this.queues.get(code) === next) this.queues.delete(code);
      })
      .catch(() => {});
    return next;
  }
  prepare(r, now) {
    synchronize(r);
    const actor = r.players[r.currentTurnIndex];
    if (
      r.phase === "playing" &&
      !r.pause &&
      (actor?.isBot || actor?.aiTakeover)
    ) {
      if (r.botTurn !== r.turnSequence || !r.botDueAt) {
        r.botTurn = r.turnSequence;
        r.botDueAt = Math.min(
          Math.max(
            (r.turnEndsAt || now) - r.turnSeconds * 1000,
            actor.takeoverAt || 0,
          ) + r.rules.botDelayMs,
          r.turnEndsAt || now,
        );
      }
    } else {
      r.botDueAt = null;
      r.botTurn = null;
    }
    const candidates = [
      ...r.players.map((p) => p.graceUntil),
      ...r.players
        .filter((p) => p.connected === false)
        .map((p) => p.resumeExpiresAt),
      r.phase === "playing" && !r.pause ? r.turnEndsAt : null,
      r.phase === "round_result" ? r.resultDeadline : null,
      r.provisional?.deadline,
      r.botDueAt,
      r.matchId && active(r) ? r.startedAt + r.rules.maxMatchMs : null,
      r.phase === "lobby" ? r.createdAt + r.rules.lobbyExpiryMs : null,
      r.phase === "finished"
        ? r.completedAt +
          Math.min(r.rules.resumeMs, this.rules.finishedMemoryMs || 60000)
        : null,
    ].filter((t) => Number.isFinite(t) && t > 0);
    r.nextWakeAt = candidates.length ? Math.min(...candidates) : null;
  }
  async initialize() {
    const rooms = await this.store.load();
    for (const saved of rooms) {
      integrity(saved);
      this.rooms.set(saved.id, saved);
    }
    for (const saved of rooms)
      await this.queue(saved.id, async () => {
        const r = snapshot(saved),
          now = this.now();
        for (const p of r.players) {
          delete p.socketId;
          p.controlGeneration = (p.controlGeneration || 0) + 1;
          if (!p.isBot && p.connected !== false) {
            p.connected = false;
            p.connectedSince = null;
            p.offlineSince = now;
            p.recovered = true;
          }
        }
        // Recovery never creates a new grace window or moves an absolute deadline.
        this.resolveDue(r, now, true);
        this.prepare(r, now);
        await this.save(saved, r, null, { recovered: true });
      });
  }
  async save(previous, next, receipt, effects = {}) {
    next.version = (previous?.version || 0) + 1;
    next.updatedAt = this.now();
    this.prepare(next, next.updatedAt);
    integrity(next);
    if (receipt)
      receipt.ack = {
        ok: true,
        actionId: receipt.actionId,
        roomId: next.id,
        version: next.version,
        ...envelope(next),
      };
    const persistenceStarted = this.metrics.start();
    try {
      await this.store.commit(next, previous?.version || 0, receipt);
    } catch (e) {
      this.reloadNeeded.add(next.id);
      this.retryAt.set(next.id, this.now() + 2000);
      this.onSchedule(next.id, this.retryAt.get(next.id), false);
      throw e;
    } finally {
      this.metrics.end("persistenceMs", persistenceStarted);
    }
    if (next.closed) this.rooms.delete(next.id);
    else this.rooms.set(next.id, next);
    this.retryAt.delete(next.id);
    if (receipt) {
      this.receipts.set(`${next.id}:${receipt.seatId}:${receipt.actionId}`, {
        fingerprint: receipt.fingerprint,
        acknowledgement: receipt.ack,
      });
      if (this.receipts.size > this.rules.actionCache)
        this.receipts.delete(this.receipts.keys().next().value);
    }
    effects.finalized = !!(
      next.matchId &&
      (next.phase === "finished" || next.closed) &&
      previous?.phase !== "finished" &&
      !previous?.closed
    );
    this.onSchedule(next.id, next.closed ? null : next.nextWakeAt, true);
    effects.previous = previous;
    this.onCommit(next, effects);
    return receipt?.ack;
  }
  async synchronizeStorage(code) {
    if (!this.reloadNeeded.has(code)) return;
    let stored;
    try {
      stored = await this.store.loadRoom(code);
    } catch (e) {
      this.retryAt.set(code, this.now() + 2000);
      this.onSchedule(code, this.retryAt.get(code), false);
      throw e;
    }
    if (stored) {
      integrity(stored);
      if (!stored.closed) this.rooms.set(code, stored);
      else this.rooms.delete(code);
      this.onCommit(stored, { resynchronized: true });
    }
    this.reloadNeeded.delete(code);
    this.retryAt.delete(code);
  }
  async findReceipt(code, actor, id, fp) {
    const key = `${code}:${actor}:${id}`;
    const prior =
      this.receipts.get(key) || (await this.store.receipt(code, actor, id));
    if (!prior) return null;
    if (prior.fingerprint !== fp)
      throw error(
        "DUPLICATE_ACTION",
        "That action ID was already used for different data.",
      );
    this.receipts.set(key, prior);
    if (this.receipts.size > this.rules.actionCache)
      this.receipts.delete(this.receipts.keys().next().value);
    return { ...prior.acknowledgement, duplicate: true };
  }
  seat(r, actor) {
    const p = r.players.find((p) => p.id === actor.id);
    if (
      !p ||
      (p.accountId || null) !== (actor.accountId || null) ||
      (!actor.system && p.controlGeneration !== actor.generation)
    )
      throw error(
        "UNAUTHORIZED_SEAT",
        "This connection does not control that seat.",
      );
    return p;
  }
  async command(code, actor, event, data) {
    const fp = fingerprint(event, data);
    return this.queue(code, async () => {
      const fresh =
        data.stateVersion === this.rooms.get(code)?.version &&
        !this.reloadNeeded.has(code);
      const cached = this.receipts.has(`${code}:${actor.id}:${data.actionId}`);
      const prior =
        fresh && !cached
          ? null
          : await this.findReceipt(code, actor.id, data.actionId, fp);
      if (prior) {
        await this.synchronizeStorage(code);
        return prior;
      }
      await this.synchronizeStorage(code);
      await this.settle(code);
      const previous = this.rooms.get(code);
      if (!previous)
        throw error("ROOM_NOT_FOUND", "That table is no longer active.");
      const r = snapshot(previous);
      const p = this.seat(r, actor);
      if (event === "reclaim_control" || event === "update_profile") {
        if (data.matchId !== r.matchId)
          throw error("STALE_TURN", "That match has ended.");
      } else validateEnvelope(r, data);
      if (
        !actor.system &&
        p.aiTakeover &&
        event !== "reclaim_control" &&
        event !== "update_profile" &&
        event !== "leave_room" &&
        event !== "kick_player"
      )
        throw error(
          "AI_CONTROLLED",
          "AI controls this seat. Take back control before playing.",
        );
      const effects = this.reduce(r, p, event, data, this.now(), actor.system);
      if (
        !actor.system &&
        ["play_cards", "pass_bluff", "call_bluff"].includes(event)
      )
        presence.humanActivity(r, p, this.now());
      r.actionCount = (r.actionCount || 0) + 1;
      if (r.actionCount > r.rules.maxRoomActions)
        throw error("ACTION_LIMIT", "This match exceeded its action limit.");
      presence.tickPresence(r, this.now());
      try {
        return await this.save(
          previous,
          r,
          { seatId: actor.id, actionId: data.actionId, fingerprint: fp },
          effects,
        );
      } catch (e) {
        if (e.code === "23505") {
          const original = await this.findReceipt(
            code,
            actor.id,
            data.actionId,
            fp,
          );
          if (original) {
            await this.synchronizeStorage(code);
            return original;
          }
          if (await this.store.receiptAnywhere(actor.id, data.actionId))
            throw error("DUPLICATE_ACTION", "Action ID already used.");
        }
        throw e;
      }
    });
  }
  reduce(r, p, event, d, now, system = false) {
    if (
      ["play_cards", "pass_bluff", "call_bluff"].includes(event) &&
      r.turnEndsAt &&
      now > r.turnEndsAt &&
      !system
    )
      throw error("ACTION_EXPIRED", "The server turn deadline has expired.");
    let result;
    try {
      switch (event) {
        case "play_cards":
          result = game.applyPlay(r, p.id, d.cardIds, d.declaredRank, now);
          break;
        case "pass_bluff":
          result = game.applyPass(r, p.id, now);
          break;
        case "call_bluff":
          result = game.applyChallenge(r, p.id, d.selectedIndexes, now);
          break;
        case "continue_round":
          if (p.id !== r.hostId && !system)
            throw error("NOT_HOST", "Only the host can advance early.");
          if (r.phase !== "round_result")
            throw error("STALE_TURN", "That round already advanced.");
          game.nextRound(r, now);
          presence.updatePause(r, now);
          break;
        case "request_rematch":
          if (r.phase !== "finished")
            throw error("INVALID_STATE", "Wait for final results.");
          r.rematchRequested ||= [];
          if (!r.rematchRequested.includes(p.id)) r.rematchRequested.push(p.id);
          break;
        case "restart_game":
        case "prepare_rematch":
          if (r.phase !== "finished")
            throw error("INVALID_STATE", "Wait for final results.");
          if (p.id !== r.hostId)
            throw error("NOT_HOST", "Only the host can reopen the table.");
          Object.assign(r, {
            phase: "lobby",
            matchId: null,
            roundId: null,
            hands: {},
            pile: [],
            discard: [],
            lastMove: null,
            lastResult: null,
            winnerId: null,
            pendingWinnerId: null,
            turnEndsAt: null,
            resultDeadline: null,
            provisional: null,
            pause: null,
            roundNumber: 1,
          });
          for (const seat of r.players) {
            seat.ready = !!seat.isBot;
            seat.aiTakeover = false;
            seat.controlReason = null;
            seat.afkStrikes = 0;
            if (!seat.isBot && seat.connected === false && !seat.graceUntil) {
              seat.graceUntil = now + Math.max(0, seat.graceRemainingMs || 0);
              seat.graceStartedAt = now;
            }
          }
          // Older clients have no host-ready control: their explicit rematch click
          // confirms only the host, never the other participating humans.
          if (event === "restart_game") p.ready = true;
          break;
        case "update_settings":
          if (p.id !== r.hostId)
            throw error("NOT_HOST", "Only the host can edit settings.");
          if (r.phase !== "lobby")
            throw error(
              "INVALID_STATE",
              "Settings can only change in the lobby.",
            );
          if (
            require("./setup").validateSettings(d).maxPlayers < r.players.length
          )
            throw error(
              "INVALID_PAYLOAD",
              "Capacity cannot remove seated players.",
            );
          Object.assign(r, require("./setup").validateSettings(d));
          for (const seat of r.players) seat.ready = !!seat.isBot;
          break;
        case "set_ready":
          if (r.phase !== "lobby")
            throw error("INVALID_STATE", "The match already started.");
          if (typeof d.ready !== "boolean")
            throw error("INVALID_PAYLOAD", "ready must be boolean.");
          p.ready = d.ready;
          break;
        case "start_game":
          if (p.id !== r.hostId)
            throw error("NOT_HOST", "Only the host can deal.");
          if (r.phase !== "lobby")
            throw error("INVALID_STATE", "The match is not ready for a deal.");
          if (
            r.players.length < 2 ||
            r.players.some(
              (x) => !x.ready || (!x.isBot && x.connected === false),
            )
          )
            throw error(
              "NOT_READY",
              "Wait for at least two ready, online players.",
            );
          for (const player of r.players)
            Object.assign(player, {
              afkStrikes: 0,
              calls: 0,
              correctCalls: 0,
              aiRoundsUsed: 0,
              aiUsed: false,
              aiTakeover: false,
              controlReason: null,
              forfeit: false,
              graceRound: null,
            });
          game.startGame(r, game.createDeck(r.deckCount || 1), now);
          break;
        case "leave_room":
          presence.removePlayer(r, p.id, "left", now);
          break;
        case "kick_player": {
          if (p.id !== r.hostId)
            throw error("NOT_HOST", "Only the host can remove a player.");
          const target = r.players.find((x) => x.id === d.playerId);
          if (!target || target.id === p.id || target.isBot)
            throw error("INVALID_PLAYER", "Choose another human player.");
          r.bannedSeats ||= [];
          if (r.bannedSeats.length >= 128)
            throw error(
              "ROOM_LIMIT",
              "This table has reached its moderation limit.",
            );
          r.bannedSeats.push({
            accountId: target.accountId || null,
            resumeHash: target.resumeHash,
          });
          presence.removePlayer(r, target.id, "removed_by_host", now);
          presence.notice(
            r,
            `${target.name} was removed by the host.`,
            "warning",
            now,
          );
          break;
        }
        case "reclaim_control":
          if (!p.aiTakeover || p.connected === false)
            throw error(
              "INVALID_STATE",
              "This seat is not eligible to reclaim.",
            );
          presence.markOnline(r, p.id, now);
          break;
        case "update_profile":
          if (
            typeof d.name !== "string" ||
            !d.name.trim() ||
            !Number.isInteger(d.avatar) ||
            d.avatar < 0 ||
            d.avatar > 5 ||
            !validAvatarId(d.avatarId)
          )
            throw error("INVALID_PAYLOAD", "Invalid profile.");
          p.name = d.name.trim().slice(0, 20);
          p.avatar = d.avatar;
          p.avatarId = d.avatarId || null;
          break;
        default:
          throw error("UNKNOWN_ACTION", "That game event is not supported.");
      }
    } catch (e) {
      if (!e.code)
        e.code = e.message.includes("turn") ? "NOT_YOUR_TURN" : "INVALID_CLAIM";
      throw e;
    }
    if (["play_cards", "pass_bluff", "call_bluff"].includes(event)) {
      r.playHistory ||= [];
      r.playHistory.push({
        actionId: d.actionId || crypto.randomUUID(),
        event,
        playerId: p.id,
        round: r.roundNumber,
        at: now,
        cardIds: d.cardIds || [],
        ai: system,
      });
      r.playHistory = r.playHistory.slice(-(this.rules.historyLimit || 128));
    }
    return { event: result };
  }
  async create(actor, data, ai = false) {
    const fp = fingerprint(ai ? "create_ai_room" : "create_room", data);
    const prior = await this.store.receiptAnywhere(actor.id, data.actionId);
    if (prior) {
      if (prior.fingerprint !== fp)
        throw error("DUPLICATE_ACTION", "Setup action ID reused.");
      return { ...prior.acknowledgement, duplicate: true };
    }
    if (this.rooms.size >= this.rules.maxRooms)
      throw error(
        "RATE_LIMITED",
        "The server is at table capacity. Try again later.",
      );
    const id = crypto.randomBytes(3).toString("hex").toUpperCase();
    if (
      typeof data.name !== "string" ||
      !data.name.trim() ||
      !validAvatarId(data.avatarId)
    )
      throw error("INVALID_PAYLOAD", "Choose a player name first.");
    if (!/^[a-f0-9]{64}$/.test(actor.proposal || ""))
      throw error(
        "RESUME_SECRET_REQUIRED",
        "A private connection secret is required.",
      );
    const settings = require("./setup").validateSettings(data);
    const count = data.botCount ?? 3,
      max = ai ? count + 1 : settings.maxPlayers,
      seconds = settings.turnSeconds;
    if (
      !Number.isInteger(max) ||
      max < 2 ||
      max > 10 ||
      (ai && (!Number.isInteger(count) || count < 1 || count > 5))
    )
      throw error(
        "INVALID_PAYLOAD",
        "Choose 1 and 5 AI opponents or 2 to 10 players.",
      );
    if (![20, 30, 45, 60].includes(seconds))
      throw error("INVALID_PAYLOAD", "Invalid turn duration.");
    if (
      [...this.rooms.values()].some((r) =>
        r.players.some(
          (p) =>
            p.id === actor.id ||
            (actor.accountId && p.accountId === actor.accountId),
        ),
      )
    )
      throw error("ALREADY_SEATED", "Leave your current table first.");
    const now = this.now(),
      p = this.newSeat(actor, data, true, now);
    const r = {
      id,
      schemaVersion: 1,
      version: 0,
      createdAt: now,
      phase: "lobby",
      matchId: null,
      roundId: null,
      roundNumber: 1,
      turnSequence: 0,
      claimSequence: 0,
      players: [p],
      hostId: p.id,
      roomName: String(data.roomName || `${p.name}'s Bluff Arena`).slice(0, 32),
      hands: {},
      pile: [],
      discard: [],
      lastMove: null,
      roundRank: null,
      currentTurnIndex: 0,
      turnEndsAt: null,
      winnerId: null,
      pendingWinnerId: null,
      ...settings,
      mode: ai ? "ai" : "multiplayer",
      maxPlayers: max,
      turnSeconds: seconds,
      passwordHash: data.password
        ? hash(String(data.password).slice(0, 64))
        : null,
      rules: { ...this.rules },
      completedRounds: 0,
      presenceEvents: [],
      lastResult: null,
    };
    if (ai)
      for (let n = 0; n < count; n++)
        r.players.push({
          id: crypto.randomUUID(),
          name: `Bot ${n + 1}`,
          avatar: n,
          isBot: true,
          ready: true,
          connected: true,
        });
    const receipt = {
      seatId: actor.id,
      actionId: data.actionId,
      fingerprint: fingerprint(ai ? "create_ai_room" : "create_room", data),
    };
    const ack = await this.queue(id, () => this.save(null, r, receipt));
    return { ...ack, seatId: p.id, generation: p.controlGeneration };
  }
  newSeat(actor, data, ready, now) {
    return {
      id: actor.id,
      accountId: actor.accountId || null,
      emailVerified: !!actor.profile?.emailVerified,
      name: data.name.trim().slice(0, 20),
      avatarId: data.avatarId || null,
      avatar:
        Number.isInteger(data.avatar) && data.avatar >= 0 && data.avatar < 6
          ? data.avatar
          : 0,
      isBot: false,
      ready,
      connected: true,
      connectedSince: now,
      controlGeneration: 1,
      resumeHash: hash(actor.proposal),
      resumeExpiresAt: now + this.rules.resumeMs,
      afkStrikes: 0,
      aiRoundsUsed: 0,
    };
  }
  async eraseAccount(id) {
    for (const code of [...this.rooms.keys()])
      await this.queue(code, async () => {
        const previous = this.rooms.get(code);
        if (
          !previous ||
          ![...(previous.players || []), ...(previous.participants || [])].some(
            (p) => p.accountId === id,
          )
        )
          return;
        let r = snapshot(previous),
          names = new Set(
            [...r.players, ...(r.participants || [])]
              .filter((p) => p.accountId === id)
              .map((p) => p.name),
          );
        let removed = false;
        for (const p of [...r.players])
          if (p.accountId === id) {
            presence.removePlayer(r, p.id, "account_deleted", this.now());
            removed = true;
          }
        if (removed) {
          await this.save(previous, r, null, { erasureForfeit: true });
        }
        const beforeScrub = r;
        r = snapshot(beforeScrub);
        const scrub = (value) => {
          if (!value || typeof value !== "object") return;
          if (value.accountId === id)
            Object.assign(value, {
              accountId: null,
              name: "Deleted player",
              avatar: 0,
              avatarId: null,
            });
          for (const [key, entry] of Object.entries(value)) {
            if (
              ["text", "summary", "message", "roomName", "playerName"].includes(
                key,
              ) &&
              typeof entry === "string"
            ) {
              let text = entry;
              for (const name of names)
                if (name) text = text.replaceAll(name, "Deleted player");
              value[key] = text;
            } else if (entry && typeof entry === "object") scrub(entry);
          }
        };
        scrub(r);
        r.history = [];
        r.presenceEvents = [];
        await this.save(beforeScrub, r, null, { erased: true });
      });
    if (this.store.eraseAccount) await this.store.eraseAccount(id);
  }
  async join(code, actor, data) {
    return this.queue(code, async () => {
      const fp = fingerprint("join_room", data),
        old = await this.findReceipt(code, actor.id, data.actionId, fp);
      if (old) return old;
      const previous = this.rooms.get(code);
      if (!previous)
        throw error("ROOM_NOT_FOUND", "Room not found. Check the code.");
      if (
        [...this.rooms.values()].some((r) =>
          r.players.some(
            (p) =>
              p.id === actor.id ||
              (actor.accountId && p.accountId === actor.accountId),
          ),
        )
      )
        throw error("ALREADY_SEATED", "Leave your current table first.");
      const r = snapshot(previous);
      if (
        r.mode === "ai" ||
        r.phase !== "lobby" ||
        r.players.length >= r.maxPlayers
      )
        throw error(
          "ROOM_UNAVAILABLE",
          "This table is full or has already started.",
        );
      if (
        r.bannedSeats?.some(
          (p) =>
            (actor.accountId && p.accountId === actor.accountId) ||
            p.resumeHash === hash(actor.proposal),
        )
      )
        throw error("ROOM_BANNED", "You were removed from this table.");
      if (
        r.passwordHash &&
        hash(String(data.password || "")) !== r.passwordHash
      )
        throw error("INCORRECT_PASSWORD", "Incorrect room password.");
      if (
        typeof data.name !== "string" ||
        !data.name.trim() ||
        !validAvatarId(data.avatarId) ||
        !/^[a-f0-9]{64}$/.test(actor.proposal || "")
      )
        throw error("INVALID_PAYLOAD", "Invalid seat details.");
      const p = this.newSeat(actor, data, false, this.now());
      r.players.push(p);
      const ack = await this.save(previous, r, {
        seatId: actor.id,
        actionId: data.actionId,
        fingerprint: fp,
      });
      return { ...ack, seatId: p.id, generation: p.controlGeneration };
    });
  }
  async resume(actor, tokens) {
    const hashes = tokens
      .filter((t) => typeof t === "string" && /^[a-f0-9]{64}$/.test(t))
      .map(hash);
    const saved = [...this.rooms.values()].find((r) =>
      r.players.some(
        (p) =>
          (hashes.includes(p.resumeHash) ||
            (actor.accountId &&
              p.accountId === actor.accountId &&
              p.connected === false)) &&
          (p.accountId || null) === (actor.accountId || null),
      ),
    );
    if (!saved) return null;
    return this.queue(saved.id, async () => {
      await this.synchronizeStorage(saved.id);
      await this.settle(saved.id);
      const previous = this.rooms.get(saved.id);
      if (!previous) return null;
      const r = snapshot(previous),
        p = r.players.find(
          (p) =>
            (hashes.includes(p.resumeHash) ||
              (actor.accountId &&
                p.accountId === actor.accountId &&
                p.connected === false)) &&
            (p.accountId || null) === (actor.accountId || null),
        );
      if (!p || p.resumeExpiresAt <= this.now()) return null;
      if (actor.accountId && actor.profile)
        Object.assign(p, {
          name: actor.profile.name,
          avatar: actor.profile.avatar,
          avatarId: actor.profile.avatarId || null,
        });
      if (p.aiTakeover && p.connected !== false) presence.consumeAi(r, p);
      else presence.markOnline(r, p.id, this.now());
      p.resumeHash = hash(actor.proposal);
      p.resumeExpiresAt = this.now() + r.rules.resumeMs;
      p.controlGeneration++;
      await this.save(previous, r, null, { resumed: p.id });
      return { roomId: r.id, seatId: p.id, generation: p.controlGeneration };
    });
  }
  async disconnect(code, actor) {
    const key = `${code}:${actor.id}:${actor.generation}`;
    if (!this.pendingDisconnects.has(key))
      this.pendingDisconnects.set(key, { code, actor, at: this.now() });
    return this.queue(code, async () => {
      await this.synchronizeStorage(code);
      await this.applyPendingDisconnects(code);
    });
  }
  async applyPendingDisconnects(code) {
    for (const [key, pending] of this.pendingDisconnects) {
      if (pending.code !== code) continue;
      const { actor, at } = pending;
      const previous = this.rooms.get(code);
      if (!previous) {
        this.pendingDisconnects.delete(key);
        continue;
      }
      const r = snapshot(previous),
        p = r.players.find(
          (p) => p.id === actor.id && p.controlGeneration === actor.generation,
        );
      if (!p || p.connected === false) {
        this.pendingDisconnects.delete(key);
        continue;
      }
      // A deadline already reached at disconnect detection is resolved first.
      this.resolveDue(r, at, true);
      if (r.players.includes(p)) presence.markOffline(r, p.id, at);
      this.resolveDue(r, this.now(), true);
      await this.save(previous, r, null);
      this.pendingDisconnects.delete(key);
    }
  }
  resolveDue(r, now, recovery = false) {
    let changed = false;
    for (let count = 0; count < 10000; count++) {
      this.prepare(r, now);
      let at = r.nextWakeAt;
      if (!at || at > now || r.closed) break;
      changed = true;
      if (r.matchId && active(r) && r.startedAt + r.rules.maxMatchMs <= at) {
        r.abandoned = true;
        r.winReason = "time_limit";
        game.finishGame(r, null, at, true);
        r.closed = true;
        break;
      }
      if (r.phase === "lobby" && at >= r.createdAt + r.rules.lobbyExpiryMs) {
        r.closed = true;
        r.abandoned = true;
        break;
      }
      if (
        r.phase === "finished" &&
        at >=
          r.completedAt +
            Math.min(r.rules.resumeMs, this.rules.finishedMemoryMs || 60000)
      ) {
        r.closed = true;
        break;
      }
      if (r.phase === "provisional" && r.provisional.deadline <= at) {
        presence.removePlayer(
          r,
          r.provisional.candidateId,
          "ai_return_expired",
          at,
        );
        continue;
      }
      if (presence.tickPresence(r, at, recovery).changed) continue;
      const expired = r.players.find(
        (p) => p.connected === false && p.resumeExpiresAt <= at,
      );
      if (expired) {
        presence.removePlayer(r, expired.id, "resume_expired", at);
        continue;
      }
      if (r.phase === "round_result" && r.resultDeadline <= at) {
        game.nextRound(r, r.resultDeadline);
        presence.updatePause(r, at);
        continue;
      }
      const p = r.players[r.currentTurnIndex];
      if (r.phase !== "playing" || r.pause) break;
      if (r.botDueAt && r.botDueAt <= at && (p.isBot || p.aiTakeover)) {
        const choice = botChoice(r, p, this.random);
        this.reduce(r, p, choice.event, choice.data, r.botDueAt, true);
        presence.tickPresence(r, at, true);
        r.botDueAt = null;
        continue;
      }
      if (r.turnEndsAt && r.turnEndsAt <= at) {
        const deadline = r.turnEndsAt;
        if (!p.isBot && !p.aiTakeover && p.connected !== false) {
          p.afkStrikes = (p.afkStrikes || 0) + 1;
          presence.notice(
            r,
            `${p.name} missed a turn (${p.afkStrikes}/${r.rules.afkStrikes}). ${p.afkStrikes >= r.rules.afkStrikes ? "AI takeover or forfeit enforced." : p.afkStrikes === r.rules.afkStrikes - 1 ? "One more missed turn triggers AI takeover." : "Player may be AFK."}`,
            "afk_warning",
            deadline,
          );
          if (p.afkStrikes >= r.rules.afkStrikes) {
            presence.activateAi(r, p, "afk", deadline);
            if (!r.players.includes(p)) continue;
          }
        } else if (!p.isBot && !p.aiTakeover)
          presence.activateAi(r, p, "offline", deadline);
        if (r.lastMove) game.applyPass(r, p.id, deadline);
        else {
          r.currentTurnIndex = (r.currentTurnIndex + 1) % r.players.length;
          r.turnSequence = (r.turnSequence || 0) + 1;
          r.turnEndsAt = deadline + r.turnSeconds * 1000;
        }
        presence.tickPresence(r, deadline, true);
        continue;
      }
      break;
    }
    this.prepare(r, now);
    if (changed && r.nextWakeAt && r.nextWakeAt <= now && !r.closed)
      throw error(
        "RECOVERY_LIMIT",
        "Unresolved overdue state; recovery stopped safely.",
      );
    return changed;
  }
  async settle(code) {
    const previous = this.rooms.get(code);
    if (!previous || !previous.nextWakeAt || previous.nextWakeAt > this.now())
      return;
    const r = snapshot(previous);
    if (this.resolveDue(r, this.now(), true))
      await this.save(previous, r, null, { timer: true });
  }
  async tick() {
    if (this.stopping || !this.store.available) return;
    const now = this.now();
    await Promise.allSettled(
      [...this.rooms.values()]
        .filter(
          (r) =>
            ((r.nextWakeAt && r.nextWakeAt <= now) ||
              this.reloadNeeded.has(r.id)) &&
            (this.retryAt.get(r.id) || 0) <= now,
        )
        .map((r) => this.wake(r.id)),
    );
  }
  async wake(code) {
    if (this.stopping || !this.store.available) return;
    return this.queue(code, async () => {
      let failed = false;
      try {
        await this.synchronizeStorage(code);
        await this.applyPendingDisconnects(code);
        await this.settle(code);
        this.retryAt.delete(code);
      } catch (e) {
        failed = true;
        this.retryAt.set(code, this.now() + 2000);
        throw e;
      } finally {
        const r = this.rooms.get(code);
        this.onSchedule(
          code,
          r ? this.retryAt.get(code) || r.nextWakeAt : null,
          !failed && !this.reloadNeeded.has(code),
        );
      }
    });
  }
  async drain() {
    this.stopping = true;
    await Promise.allSettled([...this.queues.values()]);
    this.rooms.clear();
    this.receipts.clear();
    this.pendingDisconnects.clear();
    this.reloadNeeded.clear();
    this.retryAt.clear();
  }
}
module.exports = { RoomService, integrity, botChoice, hash };
