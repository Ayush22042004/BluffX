const crypto = require("node:crypto");
const { finishGame } = require("./game");
const GRACE_MS = 10000;
const AI_ROUNDS = 3;
const online = (p) => !p.isBot && p.connected !== false;
const activeMatch = (r) => ["playing", "round_result"].includes(r.phase);

function notice(r, message, type, now) {
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
function updatePause(r, now) {
  const waiting = r.players.filter(
    (p) => p.connected === false && !p.isBot && p.graceUntil > now,
  );
  if (waiting.length && r.phase !== "finished") {
    if (!r.pause)
      r.pause = {
        remainingMs: Math.max(0, (r.turnEndsAt || now) - now),
        turnId: r.players[r.currentTurnIndex]?.id,
      };
    r.pause.until = Math.max(...waiting.map((p) => p.graceUntil));
    r.turnEndsAt = null;
    clearTimeout(r.botTimer);
  } else if (r.pause) {
    if (r.phase === "playing")
      r.turnEndsAt =
        now +
        (r.pause.turnId === r.players[r.currentTurnIndex]?.id
          ? r.pause.remainingMs
          : r.turnSeconds * 1000);
    r.pause = null;
  }
}
function markOffline(r, id, now = Date.now()) {
  const p = r.players.find((p) => p.id === id);
  if (!p || p.isBot || p.connected === false) return false;
  Object.assign(p, {
    connected: false,
    offlineSince: now,
    graceUntil: now + GRACE_MS,
    aiTakeover: false,
  });
  notice(
    r,
    `${p.name} went offline. The table is paused for up to 10 seconds.`,
    "offline",
    now,
  );
  chooseHost(r);
  updatePause(r, now);
  return true;
}
function markOnline(r, id, now = Date.now()) {
  const p = r.players.find((p) => p.id === id);
  if (!p) return false;
  Object.assign(p, {
    connected: true,
    offlineSince: null,
    graceUntil: null,
    aiTakeover: false,
    takeoverRound: null,
  });
  notice(
    r,
    `${p.name} is back and has control of their cards.`,
    "reconnected",
    now,
  );
  chooseHost(r);
  updatePause(r, now);
  return true;
}
function removePlayer(r, id, reason = "left", now = Date.now()) {
  const index = r.players.findIndex((p) => p.id === id);
  if (index < 0) return null;
  const player = r.players[index];
  const activeId = r.players[r.currentTurnIndex]?.id;
  clearTimeout(r.botTimer);
  // Departed hands are retired, never mixed into a bluff penalty.
  r.discard ||= [];
  r.discard.push(...(r.hands[id] || []));
  delete r.hands[id];
  r.players.splice(index, 1);
  r.currentTurnIndex =
    activeId === id
      ? index % Math.max(1, r.players.length)
      : Math.max(
          0,
          r.players.findIndex((p) => p.id === activeId),
        );
  chooseHost(r);
  notice(
    r,
    reason === "offline"
      ? `${player.name} did not return after 3 AI rounds and was removed from the table.`
      : `${player.name} left the table.`,
    "removed",
    now,
  );
  if (activeMatch(r)) {
    // Close a live claim safely when its set of opponents changes.
    if (r.lastMove) {
      r.discard.push(...r.pile);
      r.pile = [];
      r.lastMove = null;
      r.roundRank = null;
      r.pendingWinnerId = null;
    }
    if (r.players.length === 1) {
      r.winReason = "last_player";
      finishGame(r, r.players[0].id);
    } else {
      const empty = r.players.find((p) => r.hands[p.id]?.length === 0);
      if (empty) finishGame(r, empty.id);
      else if (r.phase === "playing") r.turnEndsAt = now + r.turnSeconds * 1000;
    }
  }
  if (!r.players.some((p) => !p.isBot)) r.closed = true;
  updatePause(r, now);
  return player;
}
function tickPresence(r, now = Date.now()) {
  let changed = false;
  const removed = [];
  for (const p of [...r.players]) {
    if (p.isBot || p.connected !== false) continue;
    if (p.graceUntil && now >= p.graceUntil) {
      p.graceUntil = null;
      changed = true;
      if (!activeMatch(r)) {
        removed.push(removePlayer(r, p.id, "left", now));
        continue;
      }
      p.aiTakeover = true;
      p.takeoverRound = r.completedRounds || 0;
      notice(
        r,
        `AI is playing for ${p.name} for up to 3 rounds while they are offline.`,
        "ai_takeover",
        now,
      );
    }
    if (
      p.aiTakeover &&
      (r.completedRounds || 0) - p.takeoverRound >= AI_ROUNDS
    ) {
      removed.push(removePlayer(r, p.id, "offline", now));
      changed = true;
    }
  }
  if (r.pause && !r.players.some((p) => p.graceUntil > now)) changed = true;
  updatePause(r, now);
  if (r.phase === "finished" && !r.players.some(online)) r.closed = true;
  return { changed, removed: removed.filter(Boolean) };
}
module.exports = {
  GRACE_MS,
  AI_ROUNDS,
  online,
  markOffline,
  markOnline,
  removePlayer,
  tickPresence,
};
