const { io: connect } = require("../../client/node_modules/socket.io-client");
const crypto = require("node:crypto");
const { envelope } = require("../src/protocol");
const { applyRoomPatch } = require("../../client/src/lib/room-state.js");
const EVENTS = new Set([
  "create_room",
  "create_ai_room",
  "join_room",
  "set_ready",
  "start_game",
  "restart_game",
  "prepare_rematch",
  "request_rematch",
  "update_settings",
  "play_cards",
  "pass_bluff",
  "call_bluff",
  "continue_round",
  "leave_room",
  "update_profile",
  "send_chat",
  "reclaim_control",
  'kick_player',
]);
function io(url, options = {}) {
  const proposal = crypto.randomBytes(32).toString("hex");
  const socket = connect(url, {
    ...options,
    auth: { stateProtocol: 2, ...options.auth, nextResumeToken: proposal },
  });
  let latest;
  socket.on("room_state", (state) => {
    latest = state;
  });
  socket.on("room_patch", (patch) => {
    const state = applyRoomPatch(latest, patch);
    if (state) socket.emitEvent(["room_state", state]);
    else
      socket.emit("sync_room", {
        roomId: patch.roomId,
        actionId: crypto.randomUUID(),
      });
  });
  // Test callers know their own proposed secret; the server never broadcasts it.
  socket.on("seat_session", (event) => {
    event.token = proposal;
  });
  const send = socket.emit.bind(socket);
  const requests = new Map();
  socket.emit = (event, data, ...args) => {
    if (EVENTS.has(event)) {
      const prior = requests.get(data?.actionId);
      data = {
        ...(prior ||
          (latest
            ? { ...envelope(latest), stateVersion: latest.version }
            : {})),
        ...data,
        actionId: data?.actionId || crypto.randomUUID(),
      };
      if (!prior) requests.set(data.actionId, data);
      if (requests.size > 512) requests.delete(requests.keys().next().value);
    }
    return send(event, data, ...args);
  };
  return socket;
}
module.exports = { io };
