// Display-only speech detection. This must never enable/disable an audio track.
export function updateVoiceActivity(meter, level, now, muted) {
  if (muted) {
    meter.speakingUntil = 0;
    return false;
  }
  const threshold = (meter.speakingUntil || 0) > now ? 0.008 : 0.015;
  if (level >= threshold) meter.speakingUntil = now + 1200;
  return (meter.speakingUntil || 0) > now;
}
