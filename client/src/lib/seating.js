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
  const large = {
    7: [
      [4, 65],
      [4, 10],
      [28, -22],
      [72, -22],
      [96, 10],
      [96, 65],
    ],
    8: [
      [3, 68],
      [3, 17],
      [25, -22],
      [50, -22],
      [75, -22],
      [97, 17],
      [97, 68],
    ],
    9: [
      [3, 70],
      [3, 30],
      [15, -14],
      [38, -22],
      [62, -22],
      [85, -14],
      [97, 30],
      [97, 70],
    ],
    10: [
      [3, 72],
      [3, 33],
      [12, -14],
      [31, -22],
      [50, -22],
      [69, -22],
      [88, -14],
      [97, 33],
      [97, 72],
    ],
  };
  const [x, y] = (POSITIONS[total] || large[total])?.[index] || [50, -24];
  return { "--seat-x": x + "%", "--seat-y": y + "%" };
}
