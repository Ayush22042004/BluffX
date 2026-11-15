const crypto = require("node:crypto");
const { finishGame } = require("./game");
const { RULES } = require("./rules");
const online = (p) => !p.isBot && p.connected !== false && !p.aiTakeover;
const CONTROLLERS = Object.freeze({
  ACTIVE: "HUMAN_ACTIVE",
  WARNING: "HUMAN_AFK_WARNING",
  FINAL: "HUMAN_AFK_FINAL_WARNING",
  GRACE: "OFFLINE_GRACE",
  AI: "AI_CONTROLLING",
  REMOVED: "REMOVED",
});
function controllerState(p, limit = RULES.afkStrikes) {
  if (p.forfeit || p.eliminatedAt) return CONTROLLERS.REMOVED;
  if (p.isBot || p.aiTakeover) return CONTROLLERS.AI;
  if (p.connected === false) return CONTROLLERS.GRACE;
  return (p.afkStrikes || 0) >= Math.max(1, limit - 1)
    ? CONTROLLERS.FINAL
    : p.afkStrikes
      ? CONTROLLERS.WARNING
      : CONTROLLERS.ACTIVE;
}
function syncController(p, limit) {
  p.controllerState = controllerState(p, limit);
  return p.controllerState;
}
const rule = (r) => r.rules || RULES;
const activeMatch = (r) =>
  ["playing", "round_result", "provisional"].includes(r.phase);
function notice(r, message, type, now = Date.now()) {
  r.presenceEvents ||= [];
  r.presenceEvents.push({ id: crypto.randomUUID(), message, type, ts: now });
  r.presenceEvents = r.presenceEvents.slice(-30);
}
function chooseHost(r) {
  if (!r.players.some((p) => p.id === r.hostId && online(p)))
    r.hostId =
      r.players.find(online)?.id ||
      r.players.find((p) => !p.isBot)?.id ||
      r.players[0]?.id;
}
function consumeGrace(p, now) {
  if (p.graceStartedAt != null)
    p.graceRemainingMs = Math.max(
      0,
      (p.graceRemainingMs || 0) -
        Math.max(0, Math.min(now, p.graceUntil) - p.graceStartedAt),
    );
  p.graceStartedAt = null;
  p.graceUntil = null;
}
function consumeAi(r, p) {
  if (p.aiTakeover) {
    p.aiRoundsUsed =
      (p.aiRoundsUsed || 0) +
      Math.max(0, (r.completedRounds || 0) - (p.takeoverRound || 0));
    p.takeoverRound = r.completedRounds || 0;
  }
}
function renewAllowance(r, p, now) {
  if (
    p.connected !== false &&
    !p.aiTakeover &&
    p.connectedSince != null &&
    now - p.connectedSince >= rule(r).stableRenewalMs &&
    p.lastMeaningfulAt >= p.connectedSince
  ) {
    p.aiRoundsUsed = 0;
    p.connectedSince = now;
    p.lastRenewalAt = now;
  }
}
function updatePause(r, now, recovery = false) {
  const waiting = r.players.filter(
    (p) => p.connected === false && !p.isBot && p.graceUntil > now,
  );
  if (waiting.length && r.phase === "playing") {
    if (!r.pause)
      r.pause = {
        remainingMs: Math.max(0, (r.turnEndsAt || now) - now),
        turnId: r.players[r.currentTurnIndex]?.id,
      };
    r.pause.until = Math.max(...waiting.map((p) => p.graceUntil));
    r.turnEndsAt = null;
  } else if (r.pause) {
    if (r.phase === "playing")
      r.turnEndsAt =
        (recovery ? Math.min(now, r.pause.until) : now) +
        (r.pause.turnId === r.players[r.currentTurnIndex]?.id
          ? r.pause.remainingMs
          : r.turnSeconds * 1000);
    r.pause = null;
  }
}
function activateAi(r, p, reason, now) {
  if (p.aiTakeover) return true;
  consumeAi(r, p);
  if ((p.aiRoundsUsed || 0) >= rule(r).aiRounds) {
    removePlayer(r, p.id, reason, now);
    return false;
  }
  p.aiTakeover = true;
  p.aiUsed = true;
  p.takeoverAt = now;
  p.controlReason = reason;
  p.takeoverRound = r.completedRounds || 0;
  syncController(p);
  chooseHost(r);
  notice(
    r,
    `AI is playing for ${p.name}: ${rule(r).aiRounds - (p.aiRoundsUsed || 0)} rounds remain (${reason}).`,
    "ai_takeover",
    now,
  );
  return true;
}
function markOffline(r, id, now = Date.now()) {
  const p = r.players.find((p) => p.id === id);
  if (!p || p.isBot || p.connected === false) return false;
  renewAllowance(r, p, now);
  consumeAi(r, p);
  if (p.aiTakeover) {
    p.connected = false;
    p.connectedSince = null;
    p.offlineSince = now;
    consumeGrace(p, now);
    notice(
      r,
      `${p.name} went offline. AI continues with the existing round allowance.`,
      "offline",
      now,
    );
    syncController(p);
    chooseHost(r);
    updatePause(r, now);
    return true;
  }
  if (p.graceRound !== r.roundNumber) {
    p.graceRound = r.roundNumber;
    p.graceRemainingMs = rule(r).graceMs;
    p.originalGraceDeadline = null;
  }
  p.connected = false;
  p.connectedSince = null;
  p.offlineSince = now;
  const budget = p.graceRemainingMs || 0;
  p.graceUntil = budget ? now + budget : null;
  p.graceStartedAt = budget ? now : null;
  p.originalGraceDeadline ||= p.graceUntil;
  p.aiTakeover = false;
  syncController(p);
  notice(
    r,
    `${p.name} went offline. ${Math.ceil(budget / 1000)} seconds of reconnect grace remain this round.`,
    "offline",
    now,
  );
  if (!budget && activeMatch(r)) activateAi(r, p, "offline", now);
  chooseHost(r);
  updatePause(r, now);
  return true;
}
function markOnline(r, id, now = Date.now()) {
  const p = r.players.find((p) => p.id === id);
  if (!p) return false;
  consumeGrace(p, now);
  consumeAi(r, p);
  Object.assign(p, {
    connected: true,
    offlineSince: null,
    aiTakeover: false,
    takeoverRound: null,
    connectedSince: now,
    controlReason: null,
  });
  syncController(p);
  notice(
    r,
    `${p.name} is back and has control of their cards.`,
    "reconnected",
    now,
  );
  chooseHost(r);
  updatePause(r, now);
  if (r.provisional?.candidateId === id) {
    r.winReason = "ai_assisted";
    finishGame(r, id, now, true);
  }
  return true;
}
function removePlayer(r, id, reason = "left", now = Date.now()) {
  const index = r.players.findIndex((p) => p.id === id);
  if (index < 0) return null;
  const p = r.players[index],
    activeId = r.players[r.currentTurnIndex]?.id;
  p.forfeit = activeMatch(r);
  p.forfeitReason = reason;
  p.eliminatedAt = now;
  syncController(p);
  p.resumeExpiresAt = 0;
  r.participants ||= [];
  const prior = r.participants.find((x) => x.id === id);
  if (prior)
    Object.assign(prior, {
      forfeit: p.forfeit,
      forfeitReason: reason,
      eliminatedAt: now,
      aiUsed: !!p.aiUsed,
      calls: p.calls || 0,
      correctCalls: p.correctCalls || 0,
      controllerState: CONTROLLERS.REMOVED,
    });
  r.discard ||= [];
  r.discard.push(...(r.hands[id] || []));
  delete r.hands[id];
  r.players.splice(index, 1);
  r.currentTurnIndex =
    activeId === id
      ? index % Math.max(1, r.players.length)
      : Math.max(
          0,
          r.players.findIndex((x) => x.id === activeId),
        );
  chooseHost(r);
  notice(
    r,
    `${p.name} was removed from the table (${reason}${reason === "offline" ? `; ${rule(r).aiRounds} AI rounds completed` : ""}).`,
    "removed",
    now,
  );
  if (activeMatch(r)) {
    if (r.lastMove) {
      r.discard.push(...r.pile);
      r.pile = [];
      r.lastMove = null;
      r.roundRank = null;
      r.pendingWinnerId = null;
    }
    if (r.phase === "provisional") {
      r.phase = "playing";
      r.provisional = null;
    }
    r.turnSequence = (r.turnSequence || 0) + 1;
    if (r.players.length === 1) {
      r.winReason = "last_player";
      finishGame(r, r.players[0].id, now);
    } else {
      const empty = r.players.find((x) => r.hands[x.id]?.length === 0);
      if (empty) finishGame(r, empty.id, now);
      else if (r.phase === "playing") r.turnEndsAt = now + r.turnSeconds * 1000;
    }
  }
  if (!r.players.some((x) => !x.isBot)) {
    r.closed = true;
    r.abandoned = !r.winnerId;
  }
  updatePause(r, now);
  return p;
}
function tickPresence(r, now = Date.now(), recovery = false) {
  let changed = false;
  const removed = [];
  for (const p of [...r.players]) {
    if (p.isBot) continue;
    consumeAi(r, p);
    if (p.aiTakeover && (p.aiRoundsUsed || 0) >= rule(r).aiRounds) {
      removed.push(removePlayer(r, p.id, p.controlReason || "offline", now));
      changed = true;
      continue;
    }
    if (p.connected !== false) continue;
    if (p.graceUntil && now >= p.graceUntil) {
      const at = p.graceUntil;
      consumeGrace(p, at);
      changed = true;
      if (!activeMatch(r)) {
        removed.push(removePlayer(r, p.id, "left", at));
        continue;
      }
      activateAi(r, p, "offline", at);
    }
  }
  if (r.pause && !r.players.some((p) => p.graceUntil > now)) changed = true;
  updatePause(r, now, recovery);
  if (r.phase === "finished" && !r.players.some(online)) r.closed = true;
  return { changed, removed: removed.filter(Boolean) };
}
function humanActivity(r, p, now) {
  p.afkStrikes = 0;
  p.lastMeaningfulAt = now;
  renewAllowance(r, p, now);
  syncController(p);
}
module.exports = {
  CONTROLLERS,
  controllerState,
  syncController,
  GRACE_MS: RULES.graceMs,
  AI_ROUNDS: RULES.aiRounds,
  online,
  notice,
  chooseHost,
  markOffline,
  markOnline,
  removePlayer,
  tickPresence,
  activateAi,
  humanActivity,
  consumeAi,
  updatePause,
};
