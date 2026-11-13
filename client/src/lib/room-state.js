export function applyRoomPatch(state, patch) {
  if (
    !state ||
    state.roomId !== patch.roomId ||
    state.version !== patch.baseVersion
  )
    return null;
  if (patch.version <= state.version) return state;
  const next = {
    ...state,
    ...patch.changes,
    version: patch.version,
    serverNow: patch.serverNow,
  };
  next.you = next.players.find((p) => p.id === state.you.id);
  if (Object.hasOwn(patch, "hand")) next.hand = patch.hand;
  return next;
}
