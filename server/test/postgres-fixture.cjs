// Test processes only: exercise the PostgreSQL driver API without a cloud account.
// Production never loads this fixture or falls back to temporary storage.
const { newDb } = require("pg-mem");
require("pg").Pool = newDb().adapters.createPg().Pool;
process.env.DATABASE_URL = "postgresql://test-only";
process.env.MAIL_PROVIDER = "local";
process.env.NODE_ENV = "development";
