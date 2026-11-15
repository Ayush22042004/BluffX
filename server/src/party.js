const crypto = require("node:crypto");
const PARTY_RULES = Object.freeze({ capacity: 10, inviteMs: 600000, receipts: 512, socketBurst: 20, socketRefill: 2, accountBurst: 12, accountRefill: 0.5, maxPayloadBytes: 1024 });
const EVENTS = ["party_sync", "party_create", "party_invite", "party_accept", "party_decline", "party_leave", "party_kick"];
const failure = (message) => Object.assign(Error(message), { code: "PARTY_UNAVAILABLE" });

function createParty({ db, io, limiter, onChange = () => {} }) {
  const receipts = new Map();
  let closed = false;
  // Serialize publish order as well as transactions; one authoritative process
  // already owns this database. No timer, polling, SDP or audio persistence.
  let pending = Promise.resolve();
  const serialize = (work) => {
    const task = pending.then(work);
    pending = task.catch(() => {});
    return task;
  };
  const socketsFor = (id) => [...io.sockets.sockets.values()].filter(s => s.connected && s.data.accountId === id);
  async function partyFor(id) {
    return db.get("SELECT p.id,p.host_user_id FROM bx_parties p JOIN bx_party_members m ON m.party_id=p.id WHERE m.user_id=?", id);
  }
  async function publish(partyId, extra = []) {
    const party = partyId && await db.get("SELECT id,host_user_id FROM bx_parties WHERE id=?", partyId);
    const members = party ? (await db.run(
      "SELECT m.user_id,p.handle,u.name,u.avatar,a.id AS avatar_id,m.joined_at FROM bx_party_members m JOIN users u ON u.id=m.user_id JOIN bx_social_profiles p ON p.user_id=u.id LEFT JOIN player_avatars a ON a.user_id=u.id WHERE m.party_id=? AND u.deleted_at IS NULL ORDER BY m.joined_at,m.user_id", partyId,
    )).rows : [];
    const publicMembers = members.map(m => ({ id: m.handle, name: m.name, avatar: m.avatar, avatarId: m.avatar_id || null, connected: socketsFor(m.user_id).length > 0 }));
    for (const id of new Set([...members.map(m => m.user_id), ...extra])) {
      const own = members.find(m => m.user_id === id);
      for (const socket of socketsFor(id)) {
        socket.data.party = own ? { id: partyId, handle: own.handle } : null;
        socket.emit("party_state", own ? {
          id: partyId, you: own.handle,
          hostId: members.find(m => m.user_id === party.host_user_id)?.handle || members[0]?.handle,
          capacity: PARTY_RULES.capacity, members: publicMembers,
        } : null);
      }
    }
    if (partyId) onChange(partyId);
  }
  async function invites(id) {
    const rows = (await db.run(
      "SELECT i.token,i.party_id,i.expires_at,u.name,p.handle FROM bx_party_invites i JOIN users u ON u.id=i.sender JOIN bx_social_profiles p ON p.user_id=i.sender WHERE i.recipient=? AND i.expires_at>? AND u.deleted_at IS NULL ORDER BY i.expires_at DESC LIMIT 20", id, Date.now(),
    )).rows;
    for (const s of socketsFor(id)) s.emit("party_invites", rows.map(r => ({ token: r.token, partyId: r.party_id, expiresAt: Number(r.expires_at), name: r.name, playerCode: r.handle })));
  }
  async function friends(tx, a, b) {
    // Use the same stable user-row locks as friend/block mutations.
    await tx.run("SELECT id FROM users WHERE id IN (?,?) ORDER BY id FOR UPDATE", a, b);
    const blocked = await tx.get("SELECT owner FROM bx_blocks WHERE (owner=? AND target=?) OR (owner=? AND target=?)", a, b, b, a);
    const friend = await tx.get("SELECT status FROM bx_friends WHERE ((sender=? AND recipient=?) OR (sender=? AND recipient=?)) AND status='accepted'", a, b, b, a);
    if (blocked || !friend) throw failure("Only current friends can join through an invitation.");
  }
  async function remove(tx, id) {
    const old = await tx.get("SELECT party_id FROM bx_party_members WHERE user_id=?", id);
    if (!old) return null;
    await tx.run("DELETE FROM bx_party_members WHERE user_id=?", id);
    await tx.run("DELETE FROM bx_party_invites WHERE party_id=? AND sender=?", old.party_id, id);
    const next = await tx.get("SELECT user_id FROM bx_party_members WHERE party_id=? ORDER BY joined_at,user_id LIMIT 1", old.party_id);
    if (!next) await tx.run("DELETE FROM bx_parties WHERE id=?", old.party_id);
    else await tx.run("UPDATE bx_parties SET host_user_id=? WHERE id=? AND host_user_id=?", next.user_id, old.party_id, id);
    return old.party_id;
  }
  async function change(id, event, data) {
    let changed, recipient, removed;
    await db.transaction(async tx => {
      await tx.run("SELECT pg_advisory_xact_lock(71638207)");
      const user = await tx.get("SELECT id FROM users WHERE id=? AND deleted_at IS NULL", id);
      if (!user) throw failure("Sign in again to use your party.");
      const own = await tx.get("SELECT party_id FROM bx_party_members WHERE user_id=?", id);
      if (event === "party_create") {
        if (own) { changed = own.party_id; return; }
        await tx.run("INSERT INTO bx_social_profiles(user_id,handle) VALUES(?,?) ON CONFLICT(user_id) DO NOTHING", id, crypto.randomBytes(8).toString("hex"));
        changed = crypto.randomUUID();
        await tx.run("INSERT INTO bx_parties(id,host_user_id,created_at) VALUES(?,?,?)", changed, id, Date.now());
        await tx.run("INSERT INTO bx_party_members(user_id,party_id,joined_at) VALUES(?,?,?)", id, changed, Date.now());
      } else if (event === "party_accept" || event === "party_decline") {
        const invite = await tx.get("SELECT * FROM bx_party_invites WHERE token=? AND recipient=?", data.token, id);
        if (!invite || (event === "party_accept" && Number(invite.expires_at) <= Date.now())) throw failure("Party invitation expired or unavailable.");
        if (event === "party_accept") {
          if (own && own.party_id !== invite.party_id) throw failure("Leave your current party before accepting another invite.");
          await friends(tx, invite.sender, id);
          const sender = await tx.get("SELECT user_id FROM bx_party_members WHERE party_id=? AND user_id=?", invite.party_id, invite.sender);
          if (!sender) throw failure("The inviter has left this party.");
          const n = await tx.get("SELECT COUNT(*) AS n FROM bx_party_members WHERE party_id=?", invite.party_id);
          if (!own && Number(n.n) >= PARTY_RULES.capacity) throw failure("This party is full.");
          await tx.run("INSERT INTO bx_social_profiles(user_id,handle) VALUES(?,?) ON CONFLICT(user_id) DO NOTHING", id, crypto.randomBytes(8).toString("hex"));
          if (!own) await tx.run("INSERT INTO bx_party_members(user_id,party_id,joined_at) VALUES(?,?,?)", id, invite.party_id, Date.now());
          changed = invite.party_id;
        }
        await tx.run("DELETE FROM bx_party_invites WHERE token=? AND recipient=?", data.token, id);
        recipient = id;
      } else {
        if (!own || own.party_id !== data.partyId) throw failure("Your party changed. Synchronize before trying again.");
        changed = own.party_id;
        if (event === "party_invite") {
          const target = await tx.get("SELECT p.user_id FROM bx_social_profiles p JOIN users u ON u.id=p.user_id WHERE p.handle=? AND p.invites_enabled=TRUE AND u.email_verified=1 AND u.deleted_at IS NULL", data.handle);
          if (!target || target.user_id === id) throw failure("That friend cannot receive an invitation.");
          await friends(tx, id, target.user_id);
          if (await tx.get("SELECT user_id FROM bx_party_members WHERE party_id=? AND user_id=?", changed, target.user_id)) throw failure("That friend is already in your party.");
          const n = await tx.get("SELECT COUNT(*) AS n FROM bx_party_members WHERE party_id=?", changed);
          if (Number(n.n) >= PARTY_RULES.capacity) throw failure("This party is full.");
          await tx.run("DELETE FROM bx_party_invites WHERE expires_at<=?", Date.now());
          recipient = target.user_id;
          await tx.run("INSERT INTO bx_party_invites(token,party_id,sender,recipient,expires_at) VALUES(?,?,?,?,?) ON CONFLICT(party_id,recipient) DO UPDATE SET sender=EXCLUDED.sender,expires_at=EXCLUDED.expires_at", crypto.randomBytes(24).toString("hex"), changed, id, recipient, Date.now() + PARTY_RULES.inviteMs);
        } else if (event === "party_leave") {
          await remove(tx, id); removed = id;
        } else if (event === "party_kick") {
          const p = await tx.get("SELECT host_user_id FROM bx_parties WHERE id=?", changed);
          if (p.host_user_id !== id) throw failure("Only the party leader can remove members.");
          const member = await tx.get("SELECT m.user_id FROM bx_party_members m JOIN bx_social_profiles p ON p.user_id=m.user_id WHERE m.party_id=? AND p.handle=?", changed, data.handle);
          if (!member || member.user_id === id) throw failure("Choose another party member.");
          removed = member.user_id; await remove(tx, removed);
        }
      }
    });
    if (removed) {
      for (const socket of socketsFor(removed)) socket.data.party = null;
      onChange(changed);
    }
    if (changed && event !== "party_invite") await publish(changed, removed ? [removed] : []);
    if (recipient) await invites(recipient);
  }
  async function restore(socket) {
    if (closed) return;
    const id = socket.data.accountId;
    if (!id) return;
    return serialize(async () => {
      const p = await partyFor(id);
      await publish(p?.id, [id]);
      await invites(id);
    });
  }
  function attach(socket) {
    for (const event of EVENTS) socket.on(event, async (data = {}, ack) => {
      const reply = value => typeof ack === "function" && ack(value);
      try {
        limiter.consume("partySocket:" + socket.id, PARTY_RULES.socketBurst, PARTY_RULES.socketRefill);
        if (!data || typeof data !== "object" || Array.isArray(data) || Buffer.byteLength(JSON.stringify(data)) > PARTY_RULES.maxPayloadBytes) throw failure("Invalid party request.");
        await socket.data.initializing;
        if (closed) throw failure("The server is restarting. Reconnect to your party shortly.");
        const id = socket.data.accountId;
        if (!id || !socket.connected) throw failure("Sign in to create or join a party.");
        limiter.consume("party:" + id, PARTY_RULES.accountBurst, PARTY_RULES.accountRefill);
        if (event === "party_sync") { await restore(socket); reply({ ok: true }); return; }
        if (!/^[a-zA-Z0-9_-]{8,100}$/.test(data.actionId || "")) throw failure("A unique party action ID is required.");
        if (["party_accept", "party_decline"].includes(event) && !/^[a-f0-9]{48}$/.test(data.token || "")) throw failure("Invalid invitation.");
        if (["party_invite", "party_kick"].includes(event) && !/^[a-f0-9]{16}$/.test(data.handle || "")) throw failure("Invalid Player Code.");
        const key = id + ":" + data.actionId, fingerprint = JSON.stringify([event, data]);
        await serialize(async () => {
          const old = receipts.get(key);
          if (old) { if (old !== fingerprint) throw failure("Party action ID was reused."); return; }
          await change(id, event, data);
          receipts.set(key, fingerprint);
          if (receipts.size > PARTY_RULES.receipts) receipts.delete(receipts.keys().next().value);
        });
        reply({ ok: true });
      } catch (e) {
        if (!closed && socket.data.accountId && e.code === "PARTY_UNAVAILABLE" && ["party_accept", "party_decline"].includes(event))
          await invites(socket.data.accountId).catch(() => {});
        reply({ ok: false, code: e.code === "RATE_LIMITED" ? e.code : "PARTY_UNAVAILABLE", message: ["PARTY_UNAVAILABLE", "RATE_LIMITED"].includes(e.code) ? e.message : "Party storage is temporarily unavailable. Reconnect to synchronize." });
      }
    });
    socket.on("disconnect", () => {
      limiter.entries.delete("partySocket:" + socket.id);
      if (closed) return;
      const partyId = socket.data.party?.id;
      if (partyId) serialize(() => publish(partyId)).catch(() => {});
    });
  }
  return {
    attach, restore,
    async pruneDeleted() {
      const rows = (await db.run("SELECT m.user_id FROM bx_party_members m JOIN users u ON u.id=m.user_id WHERE u.deleted_at IS NOT NULL")).rows;
      for (const row of rows) await this.removeAccount(row.user_id);
    },
    async removeAccount(id) {
      if (closed) throw failure("Party cleanup will resume after server recovery.");
      await serialize(async () => {
        let old;
        await db.transaction(async tx => { await tx.run("SELECT pg_advisory_xact_lock(71638207)"); old = await remove(tx, id); });
        if (old) {
          for (const socket of socketsFor(id)) socket.data.party = null;
          onChange(old);
          await publish(old, [id]);
        }
      });
    },
    async close() { closed = true; await pending; receipts.clear(); },
  };
}
module.exports = { createParty, PARTY_RULES, PARTY_EVENTS: EVENTS };
