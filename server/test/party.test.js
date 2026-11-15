require("./postgres-fixture.cjs");
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { Pool } = require("pg");
const { startServer } = require("../src/index");
const { io } = require("./socket-client.cjs");
const { createParty } = require("../src/party");
const { RateLimiter } = require("../src/protocol");
const wait = (socket, name) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Error("Timeout " + name)), 5000);
  socket.once(name, data => { clearTimeout(timer); resolve(data); });
});
const send = (socket, event, data = {}) => new Promise((resolve, reject) => {
  const payload = event.startsWith("party_") && event !== "party_sync" ? { actionId: crypto.randomUUID(), ...data } : data;
  socket.timeout(5000).emit(event, payload, (err, result) => err ? reject(err) : resolve(result));
});

test("parties require accounts and real friend invites; membership and voice outlive tables, reconnect and leadership changes", async () => {
  const app = await startServer({ port: 0 }), pool = new Pool(), sockets = [];
  const base = "http://localhost:" + app.server.address().port;
  const users = [];
  async function account(name) {
    const id = crypto.randomUUID(), token = crypto.randomBytes(32).toString("hex"), handle = crypto.randomBytes(8).toString("hex");
    await pool.query("INSERT INTO users(id,email,name,avatar,email_verified,created_at) VALUES($1,$2,$3,0,1,$4)", [id, id + "@example.com", name, Date.now()]);
    await pool.query("INSERT INTO sessions(hash,user_id,expires_at) VALUES($1,$2,$3)", [crypto.createHash("sha256").update(token).digest("hex"), id, Date.now() + 3600000]);
    await pool.query("INSERT INTO bx_social_profiles(user_id,handle) VALUES($1,$2)", [id, handle]);
    const user = { id, handle, cookie: "bluffx_session=" + token }; users.push(user); return user;
  }
  async function connect(user) {
    const s = io(base, { autoConnect: false, transports: ["websocket"], reconnection: false, extraHeaders: user ? { Cookie: user.cookie } : {} });
    sockets.push(s); s.on("party_state", value => { s.party = value; }); s.on("party_invites", value => { s.invites = value; });
    const ready = wait(s, "server_ready"); s.connect(); await ready; return s;
  }
  try {
    const a = await account("Party Leader"), b = await account("Party Friend"), c = await account("Outsider");
    await pool.query("INSERT INTO bx_friends(sender,recipient,status,updated_at) VALUES($1,$2,'accepted',$3)", [a.id, b.id, Date.now()]);
    const sa = await connect(a), sb = await connect(b), sc = await connect(c), guest = await connect();
    assert.equal((await send(guest, "party_create")).ok, false);
    const createAction = { actionId: crypto.randomUUID() };
    assert.equal((await send(sa, "party_create", createAction)).ok, true);
    assert.equal((await send(sa, "party_create", createAction)).ok, true);
    const partyId = sa.party.id;
    assert.equal((await send(sa, "party_leave", { ...createAction, partyId })).ok, false);
    assert.equal(sa.party.hostId, a.handle);
    assert.ok(!JSON.stringify(sa.party).includes(a.id));
    assert.equal((await send(sa, "party_invite", { partyId, handle: c.handle })).ok, false);
    const invited = wait(sb, "party_invites");
    assert.equal((await send(sa, "party_invite", { partyId, handle: b.handle })).ok, true);
    await invited;
    const token = sb.invites[0].token;
    assert.equal((await send(sc, "party_accept", { token })).ok, false);
    const accept = { token, actionId: crypto.randomUUID() };
    const capacitySeats = [];
    for (let i = 0; i < 9; i++) {
      const user = await account("Capacity seat " + i); capacitySeats.push(user);
      await pool.query("INSERT INTO bx_party_members(user_id,party_id,joined_at) VALUES($1,$2,$3)", [user.id, partyId, Date.now()]);
    }
    assert.equal((await send(sb, "party_accept", accept)).ok, false);
    for (const user of capacitySeats) await pool.query("DELETE FROM bx_party_members WHERE user_id=$1", [user.id]);
    const accepted = wait(sa, "party_state");
    assert.equal((await send(sb, "party_accept", accept)).ok, true);
    await accepted;
    assert.equal((await send(sb, "party_accept", accept)).ok, true);
    assert.equal(sa.party.members.length, 2);
    assert.equal((await send(sc, "voice_join", { scope: "party" })).ok, false);
    const va = await send(sa, "voice_join", { scope: "party" });
    const vb = await send(sb, "voice_join", { scope: "party" });
    assert.equal(vb.peers.length, 2);
    const voiceId = va.peers[0].voiceId;
    const lobby = await send(sa, "create_room", { name: "Party Leader", maxPlayers: 2 });
    assert.equal(lobby.ok, true);
    assert.equal((await send(sa, "leave_room")).ok, true);
    assert.equal((await send(sa, "voice_mute", { muted: false, voiceId })).ok, true);
    assert.equal(sa.party.id, partyId);
    // Moving between channels must not let stale cleanup or mute affect the new channel.
    await send(sa, "create_room", { name: "Party Leader", maxPlayers: 2 });
    const tableVoice = await send(sa, "voice_join");
    const tableId = tableVoice.peers[0].voiceId;
    assert.notEqual(tableId, voiceId);
    await send(sa, "voice_leave", { voiceId });
    assert.equal((await send(sa, "voice_mute", { muted: false, voiceId: tableId })).ok, true);
    assert.equal((await send(sa, "voice_mute", { muted: false, voiceId })).ok, false);
    await send(sa, "voice_join", { scope: "party" });
    const oldParty = sb.party.id;
    sb.disconnect();
    const sb2 = await connect(b);
    assert.equal(sb2.party.id, oldParty);
    assert.equal(sb2.party.members.length, 2);
    const prior = sa.party.id;
    assert.equal((await send(sb2, "party_kick", { partyId: prior, handle: a.handle })).ok, false);
    assert.equal((await send(sa, "party_leave", { partyId: prior })).ok, true);
    assert.equal(sa.party, null);
    assert.equal(sb2.party.hostId, b.handle);
    assert.equal((await send(sa, "voice_join", { scope: "party" })).ok, false);
    assert.equal((await send(sb2, "party_leave", { partyId: prior })).ok, true);
    assert.equal((await pool.query("SELECT id FROM bx_parties WHERE id=$1", [prior])).rowCount, 0);
  } finally {
    for (const s of sockets) s.disconnect();
    await app.close(); await pool.end();
  }
});

test("unauthenticated party floods are bounded before any database access", async () => {
  const handlers = new Map(); let queries = 0;
  const socket = { id: "guest-party", connected: true, data: {}, on: (event, handler) => handlers.set(event, handler) };
  const party = createParty({ db: { transaction: async () => { queries++; } }, io: { sockets: { sockets: new Map() } }, limiter: new RateLimiter(() => 0) });
  party.attach(socket);
  const replies = [];
  for (let n = 0; n < 25; n++) replies.push(await new Promise(resolve => handlers.get("party_create")({ actionId: crypto.randomUUID() }, resolve)));
  assert.equal(queries, 0);
  assert.equal(replies.filter(r => r.code === "RATE_LIMITED").length, 5);
});

test("party storage failures are sanitized and never acknowledge a committed membership", async () => {
  const handlers = new Map(); const socket = { connected: true, data: { accountId: "a" }, on: (event, handler) => handlers.set(event, handler) };
  const party = createParty({ db: { transaction: async () => { throw Object.assign(Error("PRIVATE DATABASE URL"), { code: "XX000" }); } }, io: { sockets: { sockets: new Map() } }, limiter: new RateLimiter() });
  party.attach(socket);
  const result = await new Promise(resolve => handlers.get("party_create")({ actionId: crypto.randomUUID() }, resolve));
  assert.equal(result.ok, false); assert.doesNotMatch(result.message, /PRIVATE/);
  assert.equal(socket.data.party, undefined);
  await party.close();
  const stopped = await new Promise(resolve => handlers.get("party_create")({ actionId: crypto.randomUUID() }, resolve));
  assert.match(stopped.message, /restarting/);
});
