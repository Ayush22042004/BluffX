import { BUILD } from "./build";
import { API_URL } from "./endpoints";
const sent = new Map();
export function reportDiagnostic(code) {
  if (
    !["CLIENT_RENDER_ERROR", "UNHANDLED_REJECTION", "WINDOW_ERROR"].includes(
      code,
    ) ||
    navigator.onLine === false
  )
    return;
  const now = Date.now();
  if (now - (sent.get(code) || 0) < 300000) return;
  sent.set(code, now);
  fetch(
    `${API_URL}/auth/report`,
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        category: "other",
        description: "Automatic diagnostic: application error.",
        codes: [code],
        build: BUILD,
      }),
      signal: AbortSignal.timeout(5000),
    },
  ).catch(() => {});
}
