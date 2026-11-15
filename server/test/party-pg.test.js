const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { createGameStore } = require("../src/game-store");
const { startServer } = require("../src/index");
const { io } = require("./socket-client.cjs");
const URL = process.env.TEST_DATABASE_URL;
test("real PostgreSQL: party membership and invites survive restart; friend checks, expiry and atomic uniqueness remain authoritative", { skip: !URL, timeout: 180000 }, async () => {
  let store = await createGameStore({ connectionString: URL, directUrl: URL, autoMigrate: true });
  let server = await startServer({ port: 0, store });
  const users = [], sockets = [];
  const send = (s, event, data = {}) => new Promise((resolve, reject) => s.timeout(12000).emit(event, { actionId: crypto.randomUUID(), ...data }, (err, r) => err ? reject(err) : resolve(r)));
  async function connect(user) {
    const socket = io("http://localhost:" + server.server.address().port, { transports: ["websocket"], autoConnect: false, reconnection: false, extraHeaders: { Cookie: user.cookie } });
    sockets.push(socket);
    socket.on("party_state", p => { socket.party = p; }); socket.on("party_invites", p => { socket.invites = p; });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("Party recovery timed out")), 15000);
      socket.once("server_ready", () => { clearTimeout(timer); resolve(); }); socket.connect();
    });
    return socket;
  }
  try {
    for (const name of ["PG Party A", "PG Party B"]) {
      const id = crypto.randomUUID(), token = crypto.randomBytes(32).toString("hex"), handle = crypto.randomBytes(8).toString("hex");
      await store.pool.query("INSERT INTO users(id,email,name,avatar,email_verified,created_at) VALUES($1,$2,$3,0,1,$4)", [id, id + "@example.com", name, Date.now()]);
      await store.pool.query("INSERT INTO sessions(hash,user_id,expires_at) VALUES($1,$2,$3)", [crypto.createHash("sha256").update(token).digest("hex"), id, Date.now() + 3600000]);
      await store.pool.query("INSERT INTO bx_social_profiles(user_id,handle) VALUES($1,$2)", [id, handle]);
      users.push({ id, handle, cookie: "bluffx_session=" + token });
    }
    const [a, b] = users;
    await store.pool.query("INSERT INTO bx_friends(sender,recipient,status,updated_at) VALUES($1,$2,'accepted',$3)", [a.id, b.id, Date.now()]);
    let sa = await connect(a), sb = await connect(b);
    // Two connections for one account cannot create two persistent parties.
    const sa2 = await connect(a);
    const creates = await Promise.all([send(sa, "party_create"), send(sa2, "party_create")]);
    assert.ok(creates.every(r => r.ok));
    const partyId = sa.party.id;
    assert.equal((await store.pool.query("SELECT party_id FROM bx_party_members WHERE user_id=$1", [a.id])).rowCount, 1);
    const invited = new Promise(resolve => sb.once("party_invites", resolve));
    assert.equal((await send(sa, "party_invite", { partyId, handle: b.handle })).ok, true);
    await invited;
    const token = sb.invites[0].token;
    for (const s of sockets) s.disconnect();
    await server.close();
    store = await createGameStore({ connectionString: URL, directUrl: URL });
    server = await startServer({ port: 0, store });
    sa = await connect(a); sb = await connect(b);
    assert.equal(sa.party.id, partyId); assert.equal(sb.invites[0].token, token);
    const failedToken = crypto.randomBytes(24).toString("hex");
    assert.equal((await send(sb, "party_accept", { token: failedToken })).ok, false);
    await store.pool.query("INSERT INTO bx_blocks(owner,target) VALUES($1,$2)", [b.id, a.id]);
    assert.equal((await send(sb, "party_accept", { token })).ok, false);
    assert.equal((await store.pool.query("SELECT user_id FROM bx_party_members WHERE user_id=$1", [b.id])).rowCount, 0);
    await store.pool.query("DELETE FROM bx_blocks WHERE owner=$1 AND target=$2", [b.id, a.id]);
    await store.pool.query("UPDATE bx_party_invites SET expires_at=0 WHERE token=$1", [token]);
    assert.equal((await send(sb, "party_accept", { token })).ok, false);
    assert.equal(sb.invites.length, 0);
    const reinvited = new Promise(resolve => sb.once("party_invites", resolve));
    assert.equal((await send(sa, "party_invite", { partyId, handle: b.handle })).ok, true);
    await reinvited;
    assert.equal((await send(sb, "party_accept", { token: sb.invites[0].token })).ok, true);
    assert.equal(sb.party.id, partyId);
    assert.equal(sb.party.members.length, 2);
    assert.ok(!JSON.stringify(sb.party).includes(a.id));
    const kicked = new Promise(resolve => sb.once("party_state", resolve));
    assert.equal((await send(sa, "party_kick", { partyId, handle: b.handle })).ok, true);
    await kicked;
    assert.equal(sb.party, null);
    assert.equal((await send(sa, "party_leave", { partyId })).ok, true);
    assert.equal((await store.pool.query("SELECT id FROM bx_parties WHERE id=$1", [partyId])).rowCount, 0);
  } finally {
    for (const s of sockets) s.disconnect();
    for (const user of users) await store.pool.query("DELETE FROM users WHERE id=$1", [user.id]);
    await server.close();
  }
});
