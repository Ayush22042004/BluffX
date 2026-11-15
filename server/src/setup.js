const PRESETS = Object.freeze({
  classic: { maxPlayers: 4, deckCount: 1, turnSeconds: 30 },
  party: { maxPlayers: 10, deckCount: 2, turnSeconds: 20 },
  quick: { maxPlayers: 4, deckCount: 1, turnSeconds: 20 },
  custom: { maxPlayers: 4, deckCount: 1, turnSeconds: 30 },
});
const AI_STYLES = Object.freeze({
  casual: { respond: 0.18, challenge: 0.25, pass: 0.8, truth: 0.85 },
  balanced: { respond: 0.24, challenge: 0.45, pass: 0.65, truth: 0.68 },
  aggressive: { respond: 0.45, challenge: 0.7, pass: 0.35, truth: 0.4 },
});
const recommendDecks = (seats) => (seats >= 6 ? 2 : 1);
function validateSettings(data) {
  const preset = data.preset ?? "custom";
  if (!Object.hasOwn(PRESETS, preset))
    throw Object.assign(Error("Unknown preset."), { code: "INVALID_PAYLOAD" });
  const defaults = PRESETS[preset];
  const maxPlayers = Number(data.maxPlayers ?? defaults.maxPlayers);
  const deckCount = data.deckCount ?? defaults.deckCount;
  const turnSeconds = Number(data.turnSeconds ?? defaults.turnSeconds);
  const aiStyle = data.aiStyle ?? "balanced";
  if (
    !Number.isInteger(maxPlayers) ||
    maxPlayers < 2 ||
    maxPlayers > 10 ||
    ![1, 2].includes(deckCount) ||
    ![20, 30, 45, 60].includes(turnSeconds) ||
    !Object.hasOwn(AI_STYLES, aiStyle) ||
    (data.voiceEnabled !== undefined && typeof data.voiceEnabled !== "boolean")
  )
    throw Object.assign(
      Error(
        "Choose 2–10 seats, one or two decks and a supported turn duration.",
      ),
      { code: "INVALID_PAYLOAD" },
    );
  return {
    maxPlayers,
    deckCount,
    turnSeconds,
    preset,
    voiceEnabled: data.voiceEnabled !== false,
    aiStyle,
  };
}
module.exports = { PRESETS, AI_STYLES, recommendDecks, validateSettings };
