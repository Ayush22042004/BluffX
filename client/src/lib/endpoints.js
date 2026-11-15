// Missing build configuration must never send deployed clients to localhost.
export const API_URL =
  import.meta.env.VITE_SERVER_URL ||
  (import.meta.env.PROD ? window.location.origin : "http://localhost:4000");
export const SOCKET_UPGRADE = import.meta.env.VITE_SOCKET_UPGRADE !== "false";
