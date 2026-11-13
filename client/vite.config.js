import { defineConfig } from "vite";

export default defineConfig({
  define: {
    "import.meta.env.VITE_BUILD_SHA": JSON.stringify(
      (process.env.VERCEL_GIT_COMMIT || process.env.BUILD_SHA || "local").slice(
        0,
        40,
      ),
    ),
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(
      process.env.npm_package_version || "0.2.0",
    ),
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
