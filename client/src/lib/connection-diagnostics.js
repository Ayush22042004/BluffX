const known = new Set(["SOCKET_CONNECTED", "SOCKET_PING_TIMEOUT", "SOCKET_TRANSPORT_CLOSE", "SOCKET_TRANSPORT_ERROR", "SOCKET_CLIENT_CLOSED", "SOCKET_SERVER_CLOSED", "NETWORK_OFFLINE", "PAGE_HIDDEN", "PAGE_RESUMED"]);
const recent = [];
export function recordConnection(code) {
  if (!known.has(code) || recent.at(-1) === code) return;
  recent.push(code);
  if (recent.length > 10) recent.shift();
}
export const connectionDiagnostics = () => [...recent];
