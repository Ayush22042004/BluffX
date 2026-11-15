const KEY = "bluffx:voice-input-mode";
export function readCaptureMode() {
  try {
    return localStorage.getItem(KEY) === "speakers" ? "speakers" : "headphones";
  } catch {
    return "headphones";
  }
}
export function saveCaptureMode(mode) {
  try {
    localStorage.setItem(KEY, mode === "speakers" ? "speakers" : "headphones");
  } catch {
    /* Browser-local preference is optional. */
  }
}
export function captureConstraints(mode, noiseReduction = false) {
  return {
    audio: {
      echoCancellation: mode === "speakers",
      noiseSuppression: !!noiseReduction,
      autoGainControl: false,
      channelCount: 1,
    },
    video: false,
  };
}
// Sampled metadata only. Never retain microphone samples or device identifiers.
export function sampleInput(meter, values) {
  let energy = 0,
    clipped = 0,
    peak = 0;
  for (const value of values) {
    energy += value * value;
    peak = Math.max(peak, Math.abs(value));
    if (Math.abs(value) >= 0.98) clipped++;
  }
  meter.level = Math.sqrt(energy / (values.length || 1));
  meter.peak = Math.max(meter.peak || 0, peak);
  meter.sampled = (meter.sampled || 0) + values.length;
  meter.clipped = (meter.clipped || 0) + clipped;
  return meter.level;
}
export function captureReport(track, meter, mode, muteEvents = 0) {
  const settings = track?.getSettings?.() || {};
  const known = (name) => settings[name] ?? null;
  return {
    mode,
    readyState: track?.readyState || "off",
    enabled: track?.enabled ?? false,
    sourceMuted: track?.muted ?? null,
    sourceMuteEvents: muteEvents,
    echoCancellation: known("echoCancellation"),
    noiseSuppression: known("noiseSuppression"),
    autoGainControl: known("autoGainControl"),
    sampleRate: known("sampleRate"),
    channelCount: known("channelCount"),
    sampledLevelDbfs: meter?.sampled
      ? Math.round(20 * Math.log10(Math.max(meter.level, 0.000016)))
      : null,
    sampledClippingPercent: meter?.sampled
      ? Math.round((meter.clipped / meter.sampled) * 10000) / 100
      : null,
  };
}
