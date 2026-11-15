export const VOICE_BITRATE = 32000;
export const VOICE_BUFFER_MS = 120;

export function bufferVoice(receiver) {
  // A browser hint, not a guaranteed delay. Unsupported browsers retain their defaults.
  try {
    if ("jitterBufferTarget" in receiver)
      receiver.jitterBufferTarget = VOICE_BUFFER_MS;
  } catch {}
}

export async function limitVoiceSender(sender) {
  if (sender.track?.kind !== "audio") return;
  const parameters = sender.getParameters();
  if (!parameters.encodings?.length) return;
  for (const encoding of parameters.encodings)
    encoding.maxBitrate = VOICE_BITRATE;
  await sender.setParameters(parameters);
}

// Only aggregate quality counters leave getStats(). No SDP, addresses or credentials.
export function voiceQuality(report, previous) {
  const rows = [...report.values()];
  const incoming = rows.find(
    (s) => s.type === "inbound-rtp" && (s.kind || s.mediaType) === "audio",
  );
  if (!incoming)
    return { previous: null, display: { status: "Waiting for audio" } };
  const prior = previous?.id === incoming.id ? previous : incoming;
  const delta = (key) => Math.max(0, (incoming[key] || 0) - (prior[key] || 0));
  const received = delta("packetsReceived"),
    lost = delta("packetsLost");
  const pairId = rows.find(
    (s) => s.type === "transport",
  )?.selectedCandidatePairId;
  const pair =
    rows.find((s) => s.id === pairId) ||
    rows.find(
      (s) =>
        s.type === "candidate-pair" && s.nominated && s.state === "succeeded",
    );
  const local = rows.find((s) => s.id === pair?.localCandidateId);
  const remote = rows.find((s) => s.id === pair?.remoteCandidateId);
  const elapsed = (incoming.timestamp - prior.timestamp) / 1000;
  return {
    previous: { ...incoming },
    display: {
      status: "Receiving",
      packetLossPercent:
        received + lost
          ? Math.round((lost / (received + lost)) * 1000) / 10
          : 0,
      jitterMs: Math.round((incoming.jitter || 0) * 1000),
      rttMs:
        pair?.currentRoundTripTime == null
          ? null
          : Math.round(pair.currentRoundTripTime * 1000),
      audioKbps:
        elapsed > 0
          ? Math.round((delta("bytesReceived") * 8) / elapsed / 100) / 10
          : null,
      concealedPercent: delta("totalSamplesReceived")
        ? Math.round(
            (delta("concealedSamples") / delta("totalSamplesReceived")) * 1000,
          ) / 10
        : 0,
      route:
        local?.candidateType === "relay" || remote?.candidateType === "relay"
          ? "relay"
          : pair
            ? "direct"
            : "unknown",
    },
  };
}
