require("./real-db-env.cjs");
process.env.BLUFFX_TEST_DATABASE = "neon";
// Same-machine browser audio needs no paid TURN relay or production credentials.
process.env.VOICE_TURN_PROVIDER = "none";
process.env.VOICE_TURN_URL = "";
process.env.VOICE_TURN_SECRET = "";
process.env.VOICE_RELAY_ONLY = "false";
