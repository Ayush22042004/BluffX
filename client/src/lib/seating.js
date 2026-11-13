// Server array order is the turn order. Rotate around the local bottom seat.
const POSITIONS = {
  2: [[50, -24]],
  3: [
    [16, -12],
    [84, -12],
  ],
  4: [
    [9, 50],
    [50, -24],
    [91, 50],
  ],
  5: [
    [9, 50],
    [16, -12],
    [84, -12],
    [91, 50],
  ],
  6: [
    [9, 50],
    [9, 10],
    [50, -24],
    [91, 10],
    [91, 50],
  ],
};
export function clockwiseSeats(players, selfId) {
  const index = players.findIndex((p) => p.id === selfId);
  return index < 0
    ? players
    : [...players.slice(index), ...players.slice(0, index)];
}
export function opponentPosition(total, index) {
  const [x, y] = POSITIONS[total]?.[index] || [50, -24];
  return { "--seat-x": x + "%", "--seat-y": y + "%" };
}
