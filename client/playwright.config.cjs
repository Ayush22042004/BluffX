const { defineConfig } = require("@playwright/test");
module.exports = defineConfig({
  testDir: "./tests",
  timeout: 30000,
  use: { baseURL: "http://localhost:5173", headless: true, channel: "chrome" },
  workers: 1,
  reporter: "list",
  webServer: [
    {
      command:
        process.env.BLUFFX_TEST_DATABASE === "neon"
          ? "npm --prefix ../server start"
          : "npm --prefix ../server run start:test",
      env: { MAIL_PROVIDER: "local", NODE_ENV: "development" },
      url: "http://localhost:4000/health",
      reuseExistingServer: true,
    },
    {
      command: "npm run dev -- --strictPort",
      url: "http://localhost:5173",
      reuseExistingServer: true,
    },
  ],
});
