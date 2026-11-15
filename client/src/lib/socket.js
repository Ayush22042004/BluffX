import { io } from "socket.io-client";
import { applyRoomPatch } from "./room-state";
import { API_URL, SOCKET_UPGRADE } from "./endpoints";
import { createConnectionLifecycle } from "./connection-lifecycle";
import { recordConnection } from "./connection-diagnostics";

const SOCKET_URL = API_URL;
const SEAT_KEY = "bluffx:seat-resume";
const PENDING_KEY = "bluffx:seat-pending";
function secret() {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}
let proposed = "";
function connectionAuth(callback) {
  const pending = localStorage.getItem(PENDING_KEY) || "";
  proposed = pending || secret();
  localStorage.setItem(PENDING_KEY, proposed);
  callback({
    resumeToken: resumeToken(),
    pendingResumeToken: pending,
    nextResumeToken: proposed,
    stateProtocol: 2,
  });
}
const pendingActions = new Map();
export function sendGameAction(event, data = {}, state = null) {
  if (!socket.connected || !socket.gameReady)
    return Promise.resolve({
      ok: false,
      code: "SERVER_RECOVERING",
      message:
        "Connecting to BluffX server... Please wait for your saved seat.",
    });
  const payload = {
    ...data,
    matchId: state?.matchId || null,
    roundId: state?.roundId || null,
    roundSequence: state?.roundNumber || 1,
    turnSequence: state?.turnSequence || 0,
    claimSequence: state?.claimSequence || 0,
    stateVersion: state?.version,
  };
  const connectionId = socket.id;
  const key = JSON.stringify([event, payload]);
  if (pendingActions.has(key)) return pendingActions.get(key);
  payload.actionId = crypto.randomUUID();
  const started = performance.now();
  const promise = new Promise((resolve) => {
    const attempt = (retry) => {
      if (!socket.gameReady || socket.id !== connectionId) {
        resolve({
          ok: false,
          code: "SERVER_RECOVERING",
          message:
            "Connection changed. Your saved table is being synchronized.",
        });
        return;
      }
      socket.timeout(8000).emit(event, payload, (err, response) => {
        window.dispatchEvent(
          new CustomEvent("bluffx:network", {
            detail: {
              slow: err || performance.now() - started > 1500,
              acknowledgementMs: Math.round(performance.now() - started),
            },
          }),
        );
        if (err && retry && socket.connected) {
          setTimeout(() => attempt(false), 300);
          return;
        }
        resolve(
          err
            ? {
                ok: false,
                code: "CONNECTION_TIMEOUT",
                message:
                  "The action was not confirmed. Reconnect to synchronize your table.",
              }
            : response,
        );
      });
    };
    attempt(true);
  }).finally(() => pendingActions.delete(key));
  pendingActions.set(key, promise);
  return promise;
}
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
    localStorage.removeItem(PENDING_KEY);
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
  auth: connectionAuth,
  withCredentials: true,
  // Vercel's proxy uses the exact endpoint; Render receives its required slash.
  addTrailingSlash: !import.meta.env.PROD,
  // Polling also works through an HTTP reverse proxy if WebSocket upgrade is unavailable.
  transports: ["polling", "websocket"],
  upgrade: SOCKET_UPGRADE,
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 30000,
  randomizationFactor: 0.5,
  timeout: 10000,
});
let authoritativeState = null,
  syncPending = false,
  recoveryTimer,
  recoveryAttempt = 0,
  retryAfterDisconnect = false;
function retryConnection() {
  if (recoveryTimer || !navigator.onLine || !lifecycle.enabled) return;
  recoveryTimer = setTimeout(
    () => {
      recoveryTimer = null;
      if (lifecycle.enabled) socket.connect();
    },
    Math.min(30000, 1000 * 2 ** Math.min(5, recoveryAttempt++)) *
      (0.8 + Math.random() * 0.4),
  );
}
socket.on("room_state", (state) => {
  authoritativeState = state;
  syncPending = false;
});
socket.on("room_patch", (patch) => {
  if (
    authoritativeState?.roomId === patch.roomId &&
    patch.version <= authoritativeState.version
  )
    return;
  const state = applyRoomPatch(authoritativeState, patch);
  if (state) {
    socket.emitEvent(["room_state", state]);
    return;
  }
  if (!syncPending) {
    syncPending = true;
    socket.emit(
      "sync_room",
      { roomId: patch.roomId, actionId: crypto.randomUUID() },
      (response) => {
        if (!response?.ok) syncPending = false;
      },
    );
  }
});
socket.on("server_ready", () => {
  socket.gameReady = true;
  recoveryAttempt = 0;
  retryAfterDisconnect = false;
  clearTimeout(recoveryTimer);
  recoveryTimer = null;
});
socket.on("action_error", (error) => {
  retryAfterDisconnect = error.code === "STORAGE_UNAVAILABLE";
});
socket.on("connect_error", (error) => {
  if (
    !socket.active &&
    ["CONNECTION_REJECTED", "STORAGE_UNAVAILABLE"].includes(error.data?.code)
  )
    retryConnection();
});
socket.on("disconnect", (reason) => {
  const code = { "ping timeout": "SOCKET_PING_TIMEOUT", "transport close": "SOCKET_TRANSPORT_CLOSE", "transport error": "SOCKET_TRANSPORT_ERROR", "io client disconnect": "SOCKET_CLIENT_CLOSED", "io server disconnect": "SOCKET_SERVER_CLOSED" }[reason];
  if (code) recordConnection(code);
  socket.gameReady = false;
  socket.sendBuffer = [];
  syncPending = false;
  if (reason === "io client disconnect") {
    clearTimeout(recoveryTimer);
    recoveryTimer = null;
    retryAfterDisconnect = false;
  }
  if (reason === "io server disconnect" && retryAfterDisconnect)
    retryConnection();
});
socket.on("seat_session", (session) => {
  try {
    localStorage.setItem(SEAT_KEY, session.token || proposed);
    localStorage.removeItem(PENDING_KEY);
    localStorage.setItem("bluffx:seat-guest", String(!!session.guest));
  } catch {}
});
socket.on("room_left", clearSeatResume);
socket.on("room_removed", clearSeatResume);
socket.on("seat_expired", () => {
  localStorage.removeItem(SEAT_KEY);
  localStorage.removeItem("bluffx:seat-guest");
});
socket.on("connect", () => recordConnection("SOCKET_CONNECTED"));
const lifecycle = createConnectionLifecycle(socket, { window, document, navigator, record: recordConnection });
export function setSocketEnabled(enabled) {
  if (!enabled) {
    clearTimeout(recoveryTimer); recoveryTimer = null; retryAfterDisconnect = false;
    socket.sendBuffer = [];
  }
  lifecycle.setEnabled(enabled);
}
