const { isDeepStrictEqual } = require("node:util");
const { publicState } = require("./game");
class RoomDelivery {
  constructor() {
    this.views = new Map();
  }
  project(room) {
    const next = publicState(room, null);
    delete next.hand;
    delete next.you;
    return next;
  }
  prepare(room) {
    const next = this.project(room),
      previous = this.views.get(room.id);
    const changes = {};
    if (previous)
      for (const key of Object.keys(next)) {
        if (["serverNow", "version"].includes(key)) continue;
        if (!isDeepStrictEqual(previous[key], next[key]))
          changes[key] = next[key];
      }
    if (room.closed) this.views.delete(room.id);
    else this.views.set(room.id, next);
    return { next, previous, changes };
  }
  full(socket, room) {
    const common = this.views.get(room.id) || this.project(room);
    const state = {
      ...common,
      serverNow: Date.now(),
      you: common.players.find((p) => p.id === socket.data.playerId),
      hand: room.hands[socket.data.playerId] || [],
    };
    socket.data.stateVersion = room.version;
    socket.data.handKey = state.hand.map((c) => c.id).join(",");
    socket.emit("room_state", state);
  }
  send(socket, room, prepared) {
    const { next, previous, changes } = prepared;
    if (socket.data.stateVersion === room.version) return;
    if (
      socket.handshake.auth?.stateProtocol !== 2 ||
      socket.data.stateVersion !== previous?.version
    ) {
      this.full(socket, room);
      return;
    }
    const hand = room.hands[socket.data.playerId] || [],
      key = hand.map((c) => c.id).join(",");
    const patch = {
      roomId: room.id,
      baseVersion: previous.version,
      version: next.version,
      serverNow: next.serverNow,
      changes,
    };
    if (key !== socket.data.handKey) patch.hand = hand;
    socket.emit("room_patch", patch);
    socket.data.handKey = key;
    socket.data.stateVersion = room.version;
  }
}
module.exports = { RoomDelivery };
