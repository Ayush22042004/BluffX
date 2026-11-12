const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadEnvironment } = require("../src/environment");

test("Neon root env loads alongside backend secrets without replacing hosting variables", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bluffx-env-test-"));
  try {
    fs.mkdirSync(path.join(root, "server"));
    fs.writeFileSync(
      path.join(root, ".env.local"),
      "DATABASE_URL=neon-pooled\nDATABASE_URL_UNPOOLED=neon-direct\n",
    );
    fs.writeFileSync(path.join(root, ".env"), "DATABASE_URL=other-root\n");
    fs.writeFileSync(
      path.join(root, "server/.env"),
      "DATABASE_URL=old-backend\nGOOGLE_CLIENT_ID=google-id\nMAIL_PROVIDER=local\n",
    );
    const env = { PORT: "4567" };
    loadEnvironment(root, env);
    assert.equal(env.DATABASE_URL, "neon-pooled");
    assert.equal(env.DATABASE_URL_UNPOOLED, "neon-direct");
    assert.equal(env.GOOGLE_CLIENT_ID, "google-id");
    assert.equal(env.MAIL_PROVIDER, "local");
    assert.equal(env.PORT, "4567");
    const hosted = { DATABASE_URL: "render-url" };
    loadEnvironment(root, hosted);
    assert.equal(hosted.DATABASE_URL, "render-url");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
