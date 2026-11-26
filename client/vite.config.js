import { defineConfig } from "vite";
import fs from "node:fs";
const version = JSON.parse(
  fs.readFileSync(new URL("./package.json", import.meta.url), "utf8"),
).version;
const revision = (
  process.env.VERCEL_GIT_COMMIT_SHA ||
  process.env.VERCEL_GIT_COMMIT ||
  process.env.BUILD_SHA ||
  "local"
).slice(0, 40);
const testProxy = process.env.BLUFFX_TEST_API;
if (
  testProxy &&
  !["localhost", "127.0.0.1"].includes(new URL(testProxy).hostname)
)
  throw Error("Browser build tests require an isolated loopback backend.");

export default defineConfig({
  plugins: [
    {
      name: "public-build-version",
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "version.json",
          source: JSON.stringify({ version, revision }),
        });
      },
    },
  ],
  define: {
    "import.meta.env.VITE_BUILD_SHA": JSON.stringify(revision),
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(version),
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  preview: {
    proxy: testProxy
      ? {
          "/health": { target: testProxy },
          "/auth": { target: testProxy },
          "/socket.io": {
            target: testProxy,
            ws: true,
            rewrite: (path) =>
              path.replace(/^\/socket.io(?=\?|$)/, "/socket.io/"),
          },
        }
      : undefined,
  },
});
