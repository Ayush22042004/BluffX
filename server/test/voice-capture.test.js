const test = require("node:test");
const assert = require("node:assert/strict");
const {
  captureConstraints,
  captureReport,
  sampleInput,
} = require("../../client/src/lib/voice-capture.js");
test("headphones bypass speech processors while speakers retain echo protection", () => {
  assert.deepEqual(captureConstraints("headphones").audio, {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 1,
  });
  assert.equal(captureConstraints("speakers").audio.echoCancellation, true);
  assert.equal(
    captureConstraints("headphones", true).audio.noiseSuppression,
    true,
  );
});
test("sampled capture diagnostics detect clipping without gating audio or exposing device identities", () => {
  const meter = {},
    samples = new Float32Array([1, -1, 0.5, -0.5]);
  const before = [...samples];
  assert.ok(sampleInput(meter, samples) > 0.7);
  const track = {
    enabled: true,
    muted: false,
    readyState: "live",
    getSettings: () => ({
      deviceId: "private",
      groupId: "private-group",
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      sampleRate: 48000,
    }),
  };
  const report = captureReport(track, meter, "headphones", 2);
  assert.equal(report.sampledClippingPercent, 50);
  assert.equal(report.sourceMuteEvents, 2);
  assert.equal(report.echoCancellation, false);
  assert.equal(JSON.stringify(report).includes("private"), false);
  assert.deepEqual([...samples], before);
  assert.equal(track.enabled, true);
  assert.equal(
    captureReport(null, null, "headphones").sampledClippingPercent,
    null,
  );
});
