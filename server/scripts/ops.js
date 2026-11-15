require("../src/environment").loadEnvironment();
const action = process.argv[2];
if (!["metrics", "reports"].includes(action))
  throw Error("Usage: node server/scripts/ops.js metrics|reports");
if (!process.env.OPS_API_TOKEN)
  throw Error("Set OPS_API_TOKEN in your private environment.");
const base = process.env.DEPLOYMENT_BACKEND_URL || "http://localhost:4000";
fetch(`${base}/auth/ops/${action}`, {
  headers: { Authorization: `Bearer ${process.env.OPS_API_TOKEN}` },
  signal: AbortSignal.timeout(30000),
})
  .then(async (r) => {
    if (!r.ok) throw Error("Operator endpoint returned HTTP " + r.status);
    console.log(JSON.stringify(await r.json(), null, 2));
  })
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
