const test = require("node:test"),
  assert = require("node:assert/strict");
const {
  bufferVoice,
  limitVoiceSender,
  voiceQuality,
} = require("../../client/src/lib/voice-transport.js");
test("audio transport applies a bounded jitter buffer hint and bitrate without muting tracks", async () => {
  const receiver = { jitterBufferTarget: null };
  bufferVoice(receiver);
  assert.equal(receiver.jitterBufferTarget, 120);
  bufferVoice({});
  let applied;
  const track = { kind: "audio", enabled: true };
  await limitVoiceSender({
    track,
    getParameters: () => ({ encodings: [{ active: true }] }),
    setParameters: async (p) => (applied = p),
  });
  assert.equal(applied.encodings[0].maxBitrate, 32000);
  assert.equal(applied.encodings[0].active, true);
  assert.equal(track.enabled, true);
});
test("voice diagnostics use interval loss, jitter and concealment, excluding private candidate addresses", () => {
  const prior = {
    id: "audio",
    timestamp: 1000,
    packetsReceived: 100,
    packetsLost: 0,
    bytesReceived: 1000,
    totalSamplesReceived: 48000,
    concealedSamples: 0,
  };
  const report = new Map([
    [
      "audio",
      {
        ...prior,
        type: "inbound-rtp",
        kind: "audio",
        timestamp: 3000,
        packetsReceived: 190,
        packetsLost: 10,
        bytesReceived: 9000,
        totalSamplesReceived: 144000,
        concealedSamples: 960,
        jitter: 0.04,
      },
    ],
    ["t", { type: "transport", selectedCandidatePairId: "pair" }],
    [
      "pair",
      {
        id: "pair",
        type: "candidate-pair",
        localCandidateId: "ip",
        currentRoundTripTime: 0.12,
      },
    ],
    [
      "ip",
      {
        id: "ip",
        type: "local-candidate",
        candidateType: "relay",
        address: "PRIVATE-ADDRESS",
      },
    ],
  ]);
  const { display } = voiceQuality(report, prior);
  assert.equal(display.packetLossPercent, 10);
  assert.equal(display.jitterMs, 40);
  assert.equal(display.rttMs, 120);
  assert.equal(display.concealedPercent, 1);
  assert.equal(display.audioKbps, 32);
  assert.equal(display.route, "relay");
  assert.equal(JSON.stringify(display).includes("PRIVATE-ADDRESS"), false);
});
