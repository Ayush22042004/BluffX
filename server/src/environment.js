const path = require("node:path");
const dotenv = require("dotenv");

function loadEnvironment(
  root = path.resolve(__dirname, "../.."),
  env = process.env,
) {
  // Hosting/process variables win. Neon writes at the repo root; existing
  // backend-only Google/mail settings can stay in server/.env.
  return dotenv.config({
    path: [
      path.join(root, ".env.local"),
      path.join(root, ".env"),
      path.join(root, "server/.env"),
    ],
    processEnv: env,
    quiet: true,
  });
}

module.exports = { loadEnvironment };
