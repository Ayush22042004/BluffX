// Temporary Render handoff process. No database, credentials or game state loaded.
const http = require("node:http");
function startMaintenance(port = Number(process.env.PORT || 10000)) {
  const server = http.createServer((req, res) => {
    const health = req.url?.split("?")[0] === "/health";
    res.writeHead(health ? 200 : 503, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Retry-After": "30",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(JSON.stringify({
      ok: false,
      maintenance: true,
      code: "SERVER_MAINTENANCE",
      message: "BluffX is updating. Please reconnect shortly.",
    }));
  });
  server.listen(port, "0.0.0.0");
  return server;
}
if (require.main === module) {
  const server = startMaintenance();
  server.once("listening", () => console.log("BluffX maintenance handoff listening"));
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, () => server.close());
}
module.exports = { startMaintenance };
