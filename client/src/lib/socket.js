import { io } from "socket.io-client";

const SOCKET_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:4000";
const SEAT_KEY = "bluffx:seat-resume";
function resumeToken() {
  try {
    return localStorage.getItem(SEAT_KEY) || "";
  } catch {
    return "";
  }
}
export function clearSeatResume() {
  try {
    localStorage.removeItem(SEAT_KEY);
    localStorage.removeItem("bluffx:seat-guest");
  } catch {}
}
export function hasGuestSeat() {
  try {
    return (
      !!resumeToken() && localStorage.getItem("bluffx:seat-guest") === "true"
    );
  } catch {
    return false;
  }
}

export const socket = io(SOCKET_URL, {
  autoConnect: false,
  auth: (callback) => callback({ resumeToken: resumeToken() }),
  withCredentials: true,
  // Vercel's proxy uses the exact endpoint; Render receives its required slash.
  addTrailingSlash: !import.meta.env.PROD,
  // Polling also works through an HTTP reverse proxy if WebSocket upgrade is unavailable.
  transports: ["polling", "websocket"],
  upgrade: !import.meta.env.PROD,
  reconnection: true,
  timeout: 10000,
});
socket.on("seat_session", (session) => {
  try {
    localStorage.setItem(SEAT_KEY, session.token);
    localStorage.setItem("bluffx:seat-guest", String(!!session.guest));
  } catch {}
});
socket.on("room_left", clearSeatResume);
socket.on("room_removed", clearSeatResume);
socket.on("seat_expired", clearSeatResume);
let reconnectOnOnline = false;
window.addEventListener("offline", () => {
  reconnectOnOnline = socket.connected || socket.active;
  socket.disconnect();
});
window.addEventListener("online", () => {
  if (reconnectOnOnline) {
    reconnectOnOnline = false;
    socket.connect();
  }
});
window.addEventListener("pagehide", () => {
  reconnectOnOnline = socket.connected || socket.active;
  socket.disconnect();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted && reconnectOnOnline) socket.connect();
});
