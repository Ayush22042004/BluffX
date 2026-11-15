// Explicit read-only samples, never a keep-alive loop or a production load test.
const { performance } = require("node:perf_hooks");
const args = process.argv.slice(2),
  value = (key, fallback) => {
    const i = args.indexOf(key);
    return i < 0 ? fallback : args[i + 1];
  };
const url = new URL(value("--url", "http://localhost:4000/health"));
if (
  !["http:", "https:"].includes(url.protocol) ||
  url.username ||
  url.password ||
  url.pathname !== "/health" ||
  url.search
)
  throw Error(
    "Supply an HTTP(S) /health URL without credentials or query parameters.",
  );
const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
if (!local && !args.includes("--allow-live"))
  throw Error(
    "Remote sampling requires --allow-live. This performs three read-only requests.",
  );
(async () => {
  const samples = [];
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    try {
      const r = await fetch(url, {
        signal: AbortSignal.timeout(45000),
        headers: { "cache-control": "no-cache" },
      });
      const body = await r.json();
      samples.push({
        responseMs: Math.round(performance.now() - start),
        status: r.status,
        version: body.version || null,
      });
    } catch {
      samples.push({
        responseMs: Math.round(performance.now() - start),
        error: "unavailable",
      });
    }
  }
  console.log(
    JSON.stringify(
      {
        at: new Date().toISOString(),
        target: url.origin,
        samples,
        limits:
          "HTTP health round trips only; not gameplay acknowledgement, database latency, server CPU or proof of a cold start.",
      },
      null,
      2,
    ),
  );
})().catch(() => {
  console.error("Network sampling failed.");
  process.exitCode = 1;
});
