const { defineConfig } = require("@playwright/test");
module.exports = defineConfig({
  testDir: "./tests",
  timeout: 30000,
  use: { baseURL: "http://localhost:5180", headless: true, channel: "chrome" },
  workers: 1,
  reporter: "list",
  webServer: [
    {
      command:
        process.env.BLUFFX_TEST_DATABASE === "neon"
          ? "npm --prefix ../server start"
          : "npm --prefix ../server run start:test",
      env: {
        MAIL_PROVIDER: "local",
        NODE_ENV: "development",
        PORT: "4020",
        // Browser contexts share one loopback IP; production flood limits are tested separately.
        GAME_SETUP_BURST: "50",
        GAME_SETUP_PER_MINUTE: "120",
        APP_ORIGIN: "http://localhost:5180",
        CLIENT_ORIGIN: "http://localhost:5180",
        BLUFFX_TEST_TURN: process.env.BLUFFX_TEST_TURN || "false",
      },
      url: "http://localhost:4020/health",
      reuseExistingServer: false,
    },
    {
      command:
        process.env.BLUFFX_TEST_BUILD === "true"
          ? "npm run build && npm run preview -- --strictPort --port 5180"
          : "npm run dev -- --strictPort --port 5180",
      env: {
        VITE_SERVER_URL:
          process.env.BLUFFX_TEST_BUILD === "true"
            ? ""
            : "http://localhost:4020",
        BLUFFX_TEST_API:
          process.env.BLUFFX_TEST_BUILD === "true"
            ? "http://localhost:4020"
            : "",
      },
      url: "http://localhost:5180",
      reuseExistingServer: false,
    },
  ],
});
