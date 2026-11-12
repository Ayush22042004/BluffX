import { defineConfig } from "@neon/config/v1";

export default defineConfig({
  // PostgreSQL is included with every project. BluffX's Express backend uses
  // DATABASE_URL (pooled) and DATABASE_URL_UNPOOLED (schema setup/imports).
  // Existing email/password and Google authentication remain in Express.
  auth: false,
  // Branch policy: per-branch tuning
  branch: (branch) => {
    if (branch.isDefault) {
      // Default branch: no overrides, uses project defaults
      return {};
    }
    if (!branch.exists) {
      // New non-default branches: auto-expire
      // Run `neon checkout <name>` to create a new branch with these settings
      return { ttl: "7d" };
    }
    // Existing branch: no changes
    return {};
  },
});
