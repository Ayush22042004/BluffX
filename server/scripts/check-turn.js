require("../src/environment").loadEnvironment();
const { turnConfig } = require("../src/turn");
const { spawnSync } = require("node:child_process"),
  path = require("node:path");
(async () => {
  const config = await turnConfig("operator-check", {
    ...process.env,
    VOICE_RELAY_ONLY: "true",
  });
  if (config.iceTransportPolicy !== "relay")
    throw Error("Relay configuration not active");
  console.log("TURN credential generation passed; credentials are hidden.");
  if (process.argv.includes("--credentials-only")) return;
  const root = path.resolve(__dirname, "../..");
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "client/node_modules/@playwright/test/cli.js"),
      "test",
      "voice.spec.js",
    ],
    {
      cwd: path.join(root, "client"),
      env: { ...process.env, BLUFFX_TEST_TURN: "true" },
      stdio: "inherit",
    },
  );
  process.exitCode = result.status || (result.error ? 1 : 0);
})().catch(() => {
  console.error(
    "TURN verification failed. Check the key ID, token and provider settings; no credentials were printed.",
  );
  process.exitCode = 1;
});
