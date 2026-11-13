const crypto = require("node:crypto");
const { turnConfig } = require("./turn");

// Ephemeral signaling only. Never persist SDP, ICE addresses, or microphone audio.
function createVoice({ io, service, actorFor, limiter, env = process.env }) {
  const members = new Map();
  function authorized(socket) {
    const room = service.rooms.get(socket.data.roomId);
    if (!room || room.closed || !socket.connected)
      throw Error("Join a table first.");
    if (room.voiceEnabled === false)
      throw Error("Voice is disabled for this table.");
    const seat = service.seat(room, actorFor(socket));
    if (seat.isBot || seat.connected === false)
      throw Error("This seat cannot join voice.");
    return { room, seat };
  }
  function roster(roomId) {
    return [...members.values()]
      .filter((m) => m.roomId === roomId)
      .map(({ socketId, seatId, muted, voiceId }) => ({
        socketId,
        seatId,
        muted,
        voiceId,
      }));
  }
  function publish(roomId) {
    const peers = roster(roomId);
    for (const peer of peers)
      io.to(peer.socketId).emit("voice_roster", { roomId, peers });
  }
  function leave(socket) {
    const old = members.get(socket.id);
    if (!old) return;
    members.delete(socket.id);
    socket.emit("voice_closed", { voiceId: old.voiceId });
    publish(old.roomId);
  }
  function attach(socket) {
    for (const event of [
      "voice_join",
      "voice_leave",
      "voice_mute",
      "voice_signal",
    ]) {
      socket.on(event, async (data = {}, ack) => {
        const reply = (value) => {
          if (typeof ack === "function") ack(value);
        };
        try {
          limiter.consume("voice:" + socket.id, 100, 20);
          if (
            !data ||
            typeof data !== "object" ||
            Array.isArray(data) ||
            JSON.stringify(data).length > 14000
          )
            throw Error("Invalid voice request.");
          await socket.data.initializing;
          if (event === "voice_leave") {
            leave(socket);
            reply({ ok: true });
            return;
          }
          const { room, seat } = authorized(socket);
          if (event === "voice_join") {
            limiter.consume("voiceJoin:" + socket.id, 4, 0.2);
            const old = members.get(socket.id);
            const relayConfig =
              old?.relayConfig || (await turnConfig(seat.id, env));
            authorized(socket);
            if (old && old.roomId !== room.id) leave(socket);
            // Only the current authorized connection may publish this seat.
            for (const m of members.values())
              if (m.seatId === seat.id && m.socketId !== socket.id)
                leave(
                  io.sockets.sockets.get(m.socketId) || {
                    id: m.socketId,
                    emit() {},
                  },
                );
            members.set(socket.id, {
              roomId: room.id,
              socketId: socket.id,
              seatId: seat.id,
              muted: old?.muted ?? true,
              voiceId: old?.voiceId || crypto.randomUUID(),
              relayConfig,
            });
            reply({
              ok: true,
              roomId: room.id,
              peers: roster(room.id),
              ...relayConfig,
            });
            publish(room.id);
            return;
          }
          const own = members.get(socket.id);
          if (!own || own.roomId !== room.id) throw Error("Join voice first.");
          if (event === "voice_mute") {
            if (typeof data.muted !== "boolean")
              throw Error("Invalid mute state.");
            if (own.muted !== data.muted) {
              own.muted = data.muted;
              publish(room.id);
            }
          } else {
            const target = members.get(data.to);
            if (
              !target ||
              target.roomId !== room.id ||
              target.socketId === socket.id ||
              data.voiceId !== own.voiceId ||
              data.targetVoiceId !== target.voiceId
            )
              throw Error("Voice peer unavailable.");
            authorized(io.sockets.sockets.get(target.socketId));
            const signal = data.signal;
            let clean;
            if (
              signal?.description &&
              ["offer", "answer"].includes(signal.description.type) &&
              typeof signal.description.sdp === "string" &&
              signal.description.sdp.length < 12000
            ) {
              clean = {
                description: {
                  type: signal.description.type,
                  sdp: signal.description.sdp,
                },
              };
            } else if (
              signal?.candidate &&
              typeof signal.candidate.candidate === "string" &&
              signal.candidate.candidate.length < 2048 &&
              (signal.candidate.sdpMid == null ||
                typeof signal.candidate.sdpMid === "string") &&
              (signal.candidate.sdpMLineIndex == null ||
                Number.isInteger(signal.candidate.sdpMLineIndex))
            ) {
              clean = {
                candidate: {
                  candidate: signal.candidate.candidate,
                  sdpMid: signal.candidate.sdpMid ?? null,
                  sdpMLineIndex: signal.candidate.sdpMLineIndex ?? null,
                },
              };
            } else throw Error("Invalid voice signal.");
            io.to(target.socketId).emit("voice_signal", {
              from: socket.id,
              voiceId: own.voiceId,
              signal: clean,
            });
          }
          reply({ ok: true });
        } catch (e) {
          reply({
            ok: false,
            code: e.code === "RATE_LIMITED" ? e.code : "VOICE_UNAVAILABLE",
            message:
              e.code === "RATE_LIMITED"
                ? "Too many voice requests. Try again shortly."
                : "Voice unavailable. Rejoin voice at your current table.",
          });
        }
      });
    }
    socket.on("disconnect", () => {
      leave(socket);
      limiter.entries.delete("voice:" + socket.id);
      limiter.entries.delete("voiceJoin:" + socket.id);
    });
  }
  function reconcile(room) {
    for (const member of members.values()) {
      if (member.roomId !== room.id) continue;
      const socket = io.sockets.sockets.get(member.socketId);
      try {
        if (room.closed || !socket || socket.data.roomId !== room.id)
          throw Error();
        authorized(socket);
      } catch {
        leave(socket || { id: member.socketId, emit() {} });
      }
    }
  }
  return { attach, reconcile, close: () => members.clear() };
}
module.exports = { createVoice };
