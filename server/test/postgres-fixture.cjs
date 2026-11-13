// Test processes only: exercise the PostgreSQL driver API without a cloud account.
// Production never loads this fixture or falls back to temporary storage.
const { newDb } = require("pg-mem");
require("pg").Pool = newDb().adapters.createPg().Pool;
process.env.DATABASE_URL = "postgresql://test-only";
process.env.MAIL_PROVIDER = "local";
process.env.NODE_ENV = "development";
process.env.PLAYTEST_INVITE_ONLY='false';
process.env.PLAYTEST_UNRANKED='false';
if(process.env.BLUFFX_TEST_TURN!=='true') {
 process.env.VOICE_TURN_PROVIDER='none';process.env.VOICE_TURN_URL='';process.env.VOICE_TURN_SECRET='';process.env.VOICE_RELAY_ONLY='false';
} else process.env.VOICE_RELAY_ONLY='true';
require('../src/game-store').createGameStore = async () => new (require('./memory-game-store.cjs').MemoryGameStore)();
