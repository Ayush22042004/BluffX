import { io } from "socket.io-client";

const SOCKET_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:4000";

export const socket = io(SOCKET_URL, {
  autoConnect: false,
  withCredentials: true,
  // Vercel's proxy uses the exact endpoint; Render receives its required slash.
  addTrailingSlash: !import.meta.env.PROD,
  // Polling also works through an HTTP reverse proxy if WebSocket upgrade is unavailable.
  transports: ["polling", "websocket"],
  upgrade: !import.meta.env.PROD,
  reconnection: true,
  timeout: 10000,
});
