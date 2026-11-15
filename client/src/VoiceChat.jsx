import React, { useEffect, useRef, useState } from "react";
import { socket } from "./lib/socket";
import SpeakingBadge from "./SpeakingBadge";
import { updateVoiceActivity } from "./lib/voice-activity";
import {
  captureConstraints,
  captureReport,
  readCaptureMode,
  saveCaptureMode,
  sampleInput,
} from "./lib/voice-capture";
import {
  bufferVoice,
  limitVoiceSender,
  voiceQuality,
} from "./lib/voice-transport";

const request = (event, data = {}) =>
  new Promise((resolve, reject) => {
    if (!socket.connected || !socket.gameReady)
      return reject(Error("Reconnect to BluffX before joining voice."));
    socket
      .timeout(8000)
      .emit(event, data, (err, reply) =>
        err || !reply?.ok
          ? reject(
              Error(reply?.message || "Voice connection timed out. Try again."),
            )
          : resolve(reply),
      );
  });

function signalPeer(s, to, signal) {
  const target = s.roster.find((p) => p.socketId === to);
  return request("voice_signal", {
    to,
    signal,
    voiceId: s.voiceId,
    targetVoiceId: target?.voiceId,
  });
}

export default function VoiceChat({ state, onSpeakingChange, onStatusChange, scope = "table" }) {
  const [joined, setJoined] = useState(false),
    [busy, setBusy] = useState(false);
  const [muted, setMuted] = useState(true),
    [deafened, setDeafened] = useState(false);
  const [peers, setPeers] = useState([]),
    [connections, setConnections] = useState({});
  const [speaking, setSpeaking] = useState({}),
    [error, setError] = useState("");
  const [noiseReduction, setNoiseReduction] = useState(false);
  const [captureMode, setCaptureMode] = useState(readCaptureMode);
  const [inputQuality, setInputQuality] = useState(null);
  const [qualityOpen, setQualityOpen] = useState(false),
    [quality, setQuality] = useState({});
  const session = useRef(null),
    generation = useRef(0);
  const roomId = state?.roomId;
  const publishedActivity = useRef("");
  useEffect(() => { onStatusChange?.({ joined, muted, deafened }); }, [joined, muted, deafened, onStatusChange]);
  useEffect(() => () => onStatusChange?.(null), [onStatusChange]);
  useEffect(() => {
    const seatIds =
      joined && session.current?.roomId === roomId
        ? peers
            .filter(
              (p) =>
                speaking[p.socketId] &&
                !p.muted &&
                !(p.socketId === socket.id && muted),
            )
            .map((p) => p.seatId)
            .sort()
        : [];
    const signature = JSON.stringify([roomId, seatIds]);
    if (signature !== publishedActivity.current) {
      publishedActivity.current = signature;
      onSpeakingChange?.({ roomId, seatIds });
    }
  }, [speaking, peers, roomId, joined, muted, onSpeakingChange]);
  useEffect(
    () => () => onSpeakingChange?.({ roomId, seatIds: [] }),
    [roomId, onSpeakingChange],
  );

  function cleanup(notify = true) {
    generation.current++;
    const s = session.current;
    session.current = null;
    if (s) {
      clearInterval(s.meter);
      for (const p of s.peers.values()) {
        clearTimeout(p.recoveryTimer);
        p.pc.close();
        p.audio.srcObject = null;
        p.audio.remove();
        p.source?.disconnect();
      }
      s.stream.getTracks().forEach((t) => t.stop());
      s.context?.close().catch(() => {});
    }
    if (notify && s && socket.connected) socket.emit("voice_leave", { voiceId: s.voiceId });
    setJoined(false);
    setBusy(false);
    setPeers([]);
    setSpeaking({});
    setConnections({});
    setMuted(true);
    setDeafened(false);
    setQuality({});
    setInputQuality(null);
    setQualityOpen(false);
  }

  function meter(s, id, stream) {
    if (!s.context || s.meters.has(id)) return;
    const source = s.context.createMediaStreamSource(stream),
      analyser = s.context.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    s.meters.set(id, { source, analyser, bytes: new Float32Array(2048) });
    return source;
  }

  function peer(s, id) {
    if (s.peers.has(id)) return s.peers.get(id);
    const pc = new RTCPeerConnection({
      iceServers: s.iceServers,
      iceTransportPolicy: s.iceTransportPolicy || "all",
    });
    const audio = new Audio();
    audio.autoplay = true;
    audio.muted = s.deafened;
    audio.hidden = true;
    audio.setAttribute("playsinline", "");
    document.body.appendChild(audio);
    const p = {
      pc,
      audio,
      pending: [],
      queue: Promise.resolve(),
      voiceId: s.roster.find((m) => m.socketId === id)?.voiceId,
    };
    s.peers.set(id, p);
    // The answerer adopts the offer's transceiver; creating its own would leave
    // an unnegotiated sender and produce a one-way call for half the seats.
    if (socket.id < id)
      p.transceiver = pc.addTransceiver("audio", {
        direction: "sendrecv",
        streams: [s.stream],
      });
    const track = s.stream.getAudioTracks()[0];
    if (track && p.transceiver)
      p.transceiver.sender.replaceTrack(track).catch(() => {});
    pc.onicecandidate = ({ candidate }) => {
      if (candidate && session.current === s)
        signalPeer(s, id, { candidate: candidate.toJSON() }).catch(() => {});
    };
    pc.ontrack = ({ streams, receiver, track }) => {
      if (session.current !== s) return;
      const incoming = streams[0] || new MediaStream([track]);
      bufferVoice(receiver);
      if (audio.srcObject?.id !== incoming.id) audio.srcObject = incoming;
      p.source = meter(s, id, incoming);
      audio
        .play()
        .catch(() => setError("Tap Enable sound to hear voice chat."));
    };
    pc.onconnectionstatechange = () => {
      if (session.current !== s) return;
      setConnections((old) => ({ ...old, [id]: pc.connectionState }));
      if (pc.connectionState === "connected") {
        clearTimeout(p.recoveryTimer);
        p.restarts = 0;
        for (const sender of pc.getSenders())
          limitVoiceSender(sender).catch(() => {});
      }
      if (
        ["disconnected", "failed"].includes(pc.connectionState) &&
        socket.id < id &&
        !p.recoveryTimer &&
        (p.restarts || 0) < 2
      ) {
        p.recoveryTimer = setTimeout(() => {
          p.recoveryTimer = null;
          if (
            session.current !== s ||
            !s.peers.has(id) ||
            pc.connectionState === "connected"
          )
            return;
          p.queue = p.queue
            .then(async () => {
              if (pc.signalingState !== "stable" || session.current !== s)
                return;
              p.restarts = (p.restarts || 0) + 1;
              await pc.setLocalDescription(
                await pc.createOffer({ iceRestart: true }),
              );
              await signalPeer(s, id, {
                description: pc.localDescription.toJSON(),
              });
            })
            .catch(() => {
              if (session.current === s)
                setError("Voice recovery failed. Rejoin voice to retry.");
            });
        }, 5000);
      }
      if (pc.connectionState === "failed")
        setError(
          "A voice connection failed. Leave and rejoin voice; some networks require a relay.",
        );
    };
    return p;
  }

  function roster(s, list) {
    s.roster = list;
    setPeers(list);
    const ids = new Set(list.map((p) => p.socketId));
    setConnections((old) =>
      Object.fromEntries(Object.entries(old).filter(([id]) => ids.has(id))),
    );
    for (const [id, p] of s.peers)
      if (
        !ids.has(id) ||
        p.voiceId !== list.find((m) => m.socketId === id)?.voiceId
      ) {
        clearTimeout(p.recoveryTimer);
        p.pc.close();
        p.audio.srcObject = null;
        p.audio.remove();
        p.source?.disconnect();
        s.peers.delete(id);
        s.meters.delete(id);
      }
    for (const m of list) {
      if (m.socketId === socket.id || s.peers.has(m.socketId)) continue;
      const p = peer(s, m.socketId);
      // One offerer per pair prevents negotiation collisions.
      if (socket.id < m.socketId) {
        p.queue = p.queue
          .then(async () => {
            await p.pc.setLocalDescription(await p.pc.createOffer());
            if (session.current === s)
              await signalPeer(s, m.socketId, {
                description: p.pc.localDescription.toJSON(),
              });
          })
          .catch(() => {
            if (session.current === s)
              setError("Could not connect voice. Leave and rejoin to retry.");
          });
      }
    }
  }

  useEffect(() => {
    const onRoster = (data) => {
      const s = session.current;
      if (s && data.roomId === roomId) roster(s, data.peers);
    };
    const onSignal = ({ from, signal, voiceId }) => {
      const s = session.current;
      if (
        !s ||
        !s.roster.some((p) => p.socketId === from && p.voiceId === voiceId)
      )
        return;
      const p = peer(s, from);
      p.queue = p.queue
        .then(async () => {
          if (session.current !== s) return;
          if (signal.description) {
            await p.pc.setRemoteDescription(signal.description);
            for (const candidate of p.pending.splice(0))
              await p.pc.addIceCandidate(candidate);
            if (signal.description.type === "offer") {
              p.transceiver = p.pc
                .getTransceivers()
                .find((t) => t.receiver.track.kind === "audio");
              p.transceiver.direction = "sendrecv";
              await p.transceiver.sender.replaceTrack(
                s.stream.getAudioTracks()[0] || null,
              );
              await p.pc.setLocalDescription(await p.pc.createAnswer());
              await signalPeer(s, from, {
                description: p.pc.localDescription.toJSON(),
              });
            }
          } else if (signal.candidate) {
            if (p.pc.remoteDescription)
              await p.pc.addIceCandidate(signal.candidate);
            else if (p.pending.length < 64) p.pending.push(signal.candidate);
          }
        })
        .catch(() => {
          if (session.current === s)
            setError("Voice negotiation failed. Leave and rejoin to retry.");
        });
    };
    const closed = () => cleanup(false);
    const voiceClosed = (data) => {
      if (session.current && session.current.voiceId === data?.voiceId)
        cleanup(false);
    };
    socket.on("voice_roster", onRoster);
    socket.on("voice_signal", onSignal);
    socket.on("voice_closed", voiceClosed);
    socket.on("disconnect", closed);
    return () => {
      socket.off("voice_roster", onRoster);
      socket.off("voice_signal", onSignal);
      socket.off("voice_closed", voiceClosed);
      socket.off("disconnect", closed);
      cleanup();
    };
  }, [roomId]);

  useEffect(() => {
    if (!qualityOpen || !joined) return;
    let active = true,
      busy = false;
    const sample = async () => {
      const s = session.current;
      if (!s || busy) return;
      busy = true;
      try {
        const rows = {};
        await Promise.all(
          [...s.peers].map(async ([id, peer]) => {
            try {
              const measured = voiceQuality(
                await peer.pc.getStats(),
                peer.previousQuality,
              );
              peer.previousQuality = measured.previous;
              rows[id] = {
                ...measured.display,
                connection: peer.pc.connectionState,
                captureEnabled: s.stream.getAudioTracks()[0]?.enabled ?? null,
                captureMuted: s.stream.getAudioTracks()[0]?.muted ?? null,
                playbackPaused: peer.audio.paused,
                playbackMuted: peer.audio.muted,
              };
            } catch {}
          }),
        );
        if (active && session.current === s) {
          setQuality(rows);
          setInputQuality(
            captureReport(
              s.stream.getAudioTracks()[0],
              s.meters.get(socket.id),
              s.captureMode,
              s.captureMuteEvents,
            ),
          );
        }
      } finally {
        busy = false;
      }
    };
    sample();
    const timer = setInterval(sample, 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [qualityOpen, joined]);

  async function join() {
    const attempt = ++generation.current;
    setBusy(true);
    setError("");
    let stream;
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection)
        throw Error(
          "Voice needs HTTPS and a browser that supports microphone access.",
        );
      stream = new MediaStream();
      const result = await request("voice_join", { scope });
      if (generation.current !== attempt) {
        stream.getTracks().forEach((t) => t.stop());
        socket.emit("voice_leave", { voiceId: result.peers.find(p => p.socketId === socket.id)?.voiceId });
        return;
      }
      const Context = window.AudioContext || window.webkitAudioContext;
      const s = {
        roomId,
        stream,
        peers: new Map(),
        meters: new Map(),
        roster: [],
        iceServers: result.iceServers,
        iceTransportPolicy: result.iceTransportPolicy,
        voiceId: result.peers.find((p) => p.socketId === socket.id).voiceId,
        context: Context ? new Context() : null,
        muted: true,
        captureMode,
        captureMuteEvents: 0,
        deafened: false,
      };
      session.current = s;
      s.context?.resume().catch(() => {});
      s.meter = setInterval(() => {
        const active = {};
        const now = performance.now();
        for (const [id, m] of s.meters) {
          m.analyser.getFloatTimeDomainData(m.bytes);
          const level = sampleInput(m, m.bytes);
          const member = s.roster.find((p) => p.socketId === id);
          if (
            updateVoiceActivity(
              m,
              level,
              now,
              !member || member.muted || (id === socket.id && s.muted),
            )
          )
            active[id] = true;
        }
        setSpeaking((old) =>
          Object.keys(old).join() === Object.keys(active).join() ? old : active,
        );
      }, 250);
      roster(s, result.peers);
      setJoined(true);
      setMuted(true);
    } catch (e) {
      stream?.getTracks().forEach((t) => t.stop());
      if (generation.current === attempt) {
        cleanup();
        setError(
          e.name === "NotAllowedError"
            ? "Microphone permission was denied. Allow it in your browser, then try again."
            : e.message,
        );
      }
    } finally {
      if (generation.current === attempt) setBusy(false);
    }
  }

  function releaseMicrophone(s) {
    const meter = s.meters.get(socket.id);
    meter?.source.disconnect();
    s.meters.delete(socket.id);
    s.stream.getTracks().forEach((track) => {
      track.enabled = false;
      track.onended = null;
      track.onmute = null;
      track.stop();
    });
    for (const peer of s.peers.values())
      peer.transceiver?.sender.replaceTrack(null).catch(() => {});
    s.stream = new MediaStream();
  }

  async function toggleMute() {
    const s = session.current;
    if (!s || s.mutePending) return;
    s.mutePending = true;
    setBusy(true);
    setError("");
    const next = !s.muted;
    try {
      if (next) {
        releaseMicrophone(s);
        s.muted = true;
        setMuted(true);
      } else {
        const stream = await navigator.mediaDevices.getUserMedia(
          captureConstraints(captureMode, noiseReduction),
        );
        if (session.current !== s) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        stream.getAudioTracks().forEach((track) => (track.enabled = false));
        s.stream = stream;
        const track = stream.getAudioTracks()[0];
        s.captureMode = captureMode;
        s.captureMuteEvents = 0;
        track.onmute = () => {
          if (session.current === s) s.captureMuteEvents++;
        };
        await Promise.all(
          [...s.peers.values()].map((peer) =>
            peer.transceiver?.sender.replaceTrack(track),
          ),
        );
        meter(s, socket.id, stream);
        await Promise.all(
          [...s.peers.values()]
            .filter((peer) => peer.transceiver)
            .map((peer) =>
              limitVoiceSender(peer.transceiver.sender).catch(() => {}),
            ),
        );
        track.onended = () => {
          if (session.current !== s) return;
          releaseMicrophone(s);
          s.muted = true;
          setMuted(true);
          request("voice_mute", { muted: true, voiceId: s.voiceId }).catch(() => {});
          setError(
            "Microphone disconnected. You can still listen; unmute to reconnect your mic.",
          );
        };
      }
      await request("voice_mute", { muted: next, voiceId: s.voiceId });
      if (session.current !== s) return;
      s.muted = next;
      s.stream.getAudioTracks().forEach((track) => (track.enabled = !next));
      setMuted(next);
    } catch (e) {
      if (session.current === s) {
        releaseMicrophone(s);
        s.muted = true;
        setMuted(true);
        request("voice_mute", { muted: true, voiceId: s.voiceId }).catch(() => {});
        setError(
          e.name === "NotAllowedError"
            ? "Microphone permission was denied. You can still listen; allow access and unmute to try again."
            : e.message,
        );
      }
    } finally {
      s.mutePending = false;
      if (session.current === s) setBusy(false);
    }
  }

  if (!roomId) return null;
  return (
    <section className="panel voice-panel" aria-label={scope === "party" ? "Party voice chat" : "Table voice chat"}>
      <div className="voice-heading">
        <strong>🎙 {scope === "party" ? "Party Voice" : "Table Voice"}</strong>
        <span>
          {joined ? `${peers.length} connected` : "Opt-in · Audio only"}
        </span>
      </div>
      {!joined ? (
        <>
          <p>Join to listen. Your microphone opens only when you unmute.</p>
          <small>Joining {scope === "party" ? "party" : "table"} voice switches you out of your other voice channel.</small>
          <button className="secondary" disabled={busy} onClick={join}>
            {busy ? "Connecting microphone…" : "Join Voice"}
          </button>
          {busy && (
            <button className="secondary" onClick={() => cleanup()}>
              Cancel
            </button>
          )}
        </>
      ) : (
        <>
          <div className="voice-controls">
            <button
              className="secondary"
              aria-pressed={muted}
              disabled={busy}
              onClick={toggleMute}
            >
              {muted ? "Unmute Mic" : "Mute Mic"}
            </button>
            <button
              className="secondary"
              aria-pressed={deafened}
              onClick={() => {
                const s = session.current;
                if (!s) return;
                s.deafened = !s.deafened;
                setDeafened(s.deafened);
                for (const p of s.peers.values()) p.audio.muted = s.deafened;
              }}
            >
              {deafened ? "Undeafen" : "Deafen"}
            </button>
            <button className="secondary" onClick={() => cleanup()}>
              Leave Voice
            </button>
          </div>
          <p className="voice-mode">
            {muted
              ? "Listening · Your microphone is off."
              : "Open mic · Audio stays live until you mute."}
          </p>
          <fieldset className="voice-audio-setup" disabled={!muted || busy}>
            <legend>Audio setup</legend>
            <div className="voice-setup-options">
              {[
                {
                  value: "headphones",
                  title: "Headphones",
                  detail: "Natural voice",
                  path: "M4 14v-3a8 8 0 0 1 16 0v3M4 13H2v7h5v-7H4Zm16 0h2v7h-5v-7h3Z",
                },
                {
                  value: "speakers",
                  title: "Speakers",
                  detail: "Echo protection",
                  path: "m11 4-6 5H2v6h3l6 5V4Zm5 4a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14",
                },
              ].map((mode) => (
                <label key={mode.value} className="voice-setup-choice">
                  <svg
                    viewBox="0 0 24 24"
                    width="22"
                    height="22"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d={mode.path} />
                  </svg>
                  <input
                    type="radio"
                    name="voice-audio-setup"
                    aria-label={mode.title}
                    value={mode.value}
                    checked={captureMode === mode.value}
                    onChange={() => {
                      setCaptureMode(mode.value);
                      saveCaptureMode(mode.value);
                    }}
                  />
                  <span>
                    <strong>{mode.title}</strong>
                    <small>{mode.detail}</small>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <p className="voice-capture-hint">
            {captureMode === "headphones"
              ? "Use headphones. Echo cancellation and automatic gain are off."
              : "Echo protection is on for speaker playback."}
            {!muted && " Mute to change audio processing."}
          </p>
          <label className="voice-noise-option">
            <input
              type="checkbox"
              aria-label="Noise reduction"
              checked={noiseReduction}
              disabled={!muted || busy}
              onChange={(e) => setNoiseReduction(e.target.checked)}
            />
            Noise reduction (optional)
          </label>
          <ul className="voice-members">
            {peers.map((p) => {
              const player = state.players.find((x) => x.id === p.seatId);
              const self = p.seatId === state.you?.id;
              return (
                <li
                  key={p.socketId}
                  className={speaking[p.socketId] ? "is-speaking" : ""}
                >
                  <span
                    className="voice-dot"
                    aria-label={speaking[p.socketId] ? "Speaking" : undefined}
                  />
                  <span>
                    {player?.name || "Player"}
                    {self ? " (You)" : ""}
                    <small>
                      {p.muted ? (
                        "Muted"
                      ) : !self && connections[p.socketId] !== "connected" ? (
                        connections[p.socketId] || "Connecting"
                      ) : speaking[p.socketId] ? (
                        <SpeakingBadge />
                      ) : (
                        "Mic on"
                      )}
                    </small>
                  </span>
                  {!self && (
                    <input
                      aria-label={`Volume for ${player?.name || "player"}`}
                      type="range"
                      min="0"
                      max="100"
                      step="1"
                      defaultValue="100"
                      onChange={(e) => {
                        e.currentTarget.style.setProperty(
                          "--voice-volume",
                          `${e.target.value}%`,
                        );
                        const remote = session.current?.peers.get(p.socketId);
                        if (remote)
                          remote.audio.volume = Number(e.target.value) / 100;
                      }}
                    />
                  )}
                </li>
              );
            })}
          </ul>
          <details
            className="voice-quality"
            onToggle={(e) => setQualityOpen(e.currentTarget.open)}
          >
            <summary>Voice connection details</summary>
            {inputQuality && (
              <p className="voice-input-diagnostics">
                <strong>Your microphone</strong>
                <br />
                {inputQuality.readyState} ? {inputQuality.mode}
                <br />
                Echo cancellation:{" "}
                {inputQuality.echoCancellation == null
                  ? "unreported"
                  : inputQuality.echoCancellation
                    ? "on"
                    : "off"}{" "}
                ? Auto gain:{" "}
                {inputQuality.autoGainControl == null
                  ? "unreported"
                  : inputQuality.autoGainControl
                    ? "on"
                    : "off"}
                <br />
                Sampled input: {inputQuality.sampledLevelDbfs ?? "?"} dBFS ?
                Clipping: {inputQuality.sampledClippingPercent ?? "?"}%
                {inputQuality.sampledClippingPercent > 1 && (
                  <span className="voice-clipping-warning">
                    Input is clipping. Lower microphone input gain in your
                    system or headset app.
                  </span>
                )}
              </p>
            )}
            {Object.entries(quality).map(([id, q]) => (
              <p key={id}>
                <strong>
                  {state.players.find(
                    (player) =>
                      player.id ===
                      peers.find((peer) => peer.socketId === id)?.seatId,
                  )?.name || "Player"}
                </strong>
                <br />
                {q.connection} · {q.route || "unknown"} route
                <br />
                Loss {q.packetLossPercent ?? "—"}% · Jitter {q.jitterMs ?? "—"}{" "}
                ms · RTT {q.rttMs ?? "—"} ms
                <br />
                Repaired audio {q.concealedPercent ?? "—"}% ·{" "}
                {q.audioKbps ?? "—"} kbps
              </p>
            ))}
            <button
              className="secondary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(
                    JSON.stringify(
                      {
                        version: "voice-transport-3",
                        microphone: inputQuality,
                        peers: Object.values(quality),
                      },
                      null,
                      2,
                    ),
                  );
                } catch {
                  setError("Could not copy voice details.");
                }
              }}
            >
              Copy voice report
            </button>
          </details>
          {error && (
            <button
              className="secondary"
              onClick={() => {
                for (const p of session.current?.peers.values() || [])
                  p.audio.play().catch(() => {});
                session.current?.context?.resume();
                setError("");
              }}
            >
              Enable sound
            </button>
          )}
        </>
      )}
      {error && (
        <p className="voice-error" role="status">
          {error}
        </p>
      )}
    </section>
  );
}
