import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { socket } from "./lib/socket";
import { authRequest } from "./auth";
import { Avatar, Icon } from "./components";
import VoiceChat from "./VoiceChat";
import SpeakingBadge from "./SpeakingBadge";
import { formatPlayerCode } from "./lib/player-code";
import { manageDialogFocus } from "./lib/dialog-focus";
import "./party.css";

export default function PartyPanel({ account, onSignIn }) {
  const [party, setParty] = useState(null), [invites, setInvites] = useState([]);
  const [open, setOpen] = useState(false), [friends, setFriends] = useState([]);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const [voiceStatus, setVoiceStatus] = useState(null), [activity, setActivity] = useState({ seatIds: [] });
  const [online, setOnline] = useState(socket.connected && socket.gameReady);
  const dialog = useRef(null);
  const currentAccount = useRef(account?.id);
  currentAccount.current = account?.id;
  const request = (event, data = {}) => new Promise((resolve, reject) => {
    if (!socket.connected || !socket.gameReady) return reject(Error("Reconnect to use your party."));
    socket.timeout(10000).emit(event, data, (err, result) => {
      if (err || !result?.ok) reject(Error(result?.message || "Party update could not be confirmed. Reconnect to synchronize."));
      else resolve(result);
    });
  });
  useEffect(() => {
    setParty(null); setInvites([]); setFriends([]); setNotice("");
    if (!account?.id) return;
    const state = value => setParty(value);
    const inbox = value => setInvites(value);
    const ready = () => {
      setOnline(true);
    };
    const offline = () => setOnline(false);
    socket.on("party_state", state); socket.on("party_invites", inbox);
    socket.on("server_ready", ready); socket.on("disconnect", offline);
    if (socket.connected && socket.gameReady) {
      ready(); request("party_sync").catch(e => setNotice(e.message));
    }
    return () => {
      socket.off("party_state", state); socket.off("party_invites", inbox);
      socket.off("server_ready", ready); socket.off("disconnect", offline);
    };
  }, [account?.id]);
  useEffect(() => {
    if (!open || !account?.id) return;
    let active = true;
    const load = () => authRequest("social", undefined, "GET")
      .then(data => { if (active) setFriends(data.players.filter(p => p.status === "accepted")); })
      .catch(e => { if (active) setNotice(e.message); });
    load(); socket.on("social_updated", load);
    return () => { active = false; socket.off("social_updated", load); };
  }, [open, account?.id]);
  useEffect(() => {
    if (open && dialog.current) return manageDialogFocus(dialog.current, () => setOpen(false));
  }, [open]);
  async function action(event, data = {}) {
    if (busy) return;
    setBusy(true); setNotice("");
    const owner = account?.id;
    try {
      await request(event, { ...data, partyId: party?.id, actionId: crypto.randomUUID() });
      if (currentAccount.current === owner && event === "party_invite") setNotice("Party invite sent. Your friend can accept from Party.");
    } catch (e) { if (currentAccount.current === owner) setNotice(e.message); }
    finally { setBusy(false); }
  }
  const voiceState = party && {
    roomId: "party:" + party.id,
    players: party.members,
    you: { id: party.you },
  };
  return <>
    <button aria-label="Open party" onClick={() => setOpen(v => !v)} className={open ? "active" : ""}>
      <Icon name="users" /><span>{party ? `Party · ${party.members.length}` : "Party"}</span>
      {voiceStatus?.joined && <small className="party-voice-status">{voiceStatus.muted ? "Listening" : "Mic on"}</small>}
      {invites.length > 0 && <i aria-label="Party invitations" />}
    </button>
    {createPortal(<aside className={`party-dock ${open ? "is-open" : ""}`} aria-label="Your party">
      <div className="party-sheet" role={open ? "dialog" : undefined} aria-modal={open ? "true" : undefined} aria-label="Your party" ref={dialog}>
        <div className="party-heading"><div><small>STAY TOGETHER</small><h2>Your party</h2></div>
          <button className="secondary" aria-label="Close party" onClick={() => setOpen(false)}>×</button></div>
        <p className="party-description">One group, game after game. Party voice stays connected when you leave a table.</p>
        {!account ? <><p>Sign in to create a party and invite your friends.</p><button className="primary" onClick={onSignIn}>Sign in</button></> : <>
          {!online && <p role="status">Reconnecting to your party… Your membership is saved.</p>}
          {!party ? <button className="primary" disabled={busy || !online} onClick={() => action("party_create")}>Create party</button> : <>
            <div className="party-member-heading"><strong>{party.members.length} / {party.capacity} members</strong><span>Voice is optional</span></div>
            <ul className="party-members">{party.members.map(p => <li key={p.id}>
              <Avatar player={p} />
              <span><strong>{p.name}{p.id === party.you ? " (You)" : ""}</strong><small>{p.id === party.hostId ? "Party leader · " : ""}{p.connected ? "Online" : "Offline"}</small>{activity.seatIds.includes(p.id) && <SpeakingBadge />}</span>
              {party.you === party.hostId && p.id !== party.you && <button className="secondary" disabled={busy || !online} aria-label={`Remove ${p.name} from party`} onClick={() => action("party_kick", { handle: p.id })}>Remove</button>}
            </li>)}</ul>
            <VoiceChat state={voiceState} scope="party" onStatusChange={setVoiceStatus} onSpeakingChange={setActivity} />
            <div className="party-invite-list"><h3>Invite friends</h3>
              {friends.length === 0 && <p>Add friends using their Player Code in Friends, then invite them here.</p>}
              {friends.filter(f => !party.members.some(m => m.id === f.handle)).map(f => <div className="party-friend" key={f.handle}>
                <span><strong>{f.name}</strong><small>{formatPlayerCode(f.handle)}</small></span>
                <button className="secondary" disabled={busy || !online || party.members.length >= party.capacity} onClick={() => action("party_invite", { handle: f.handle })}>Invite to party</button>
              </div>)}
            </div>
            <button className="secondary party-leave" disabled={busy || !online} onClick={() => action("party_leave")}>Leave party</button>
            <small>Leaving a party does not leave your game. Refreshing or losing connection stops your microphone; rejoin voice when you return.</small>
          </>}
          {invites.length > 0 && <section className="party-invitations"><h3>Party invitations</h3>{invites.map(i => <div key={i.token} className="party-invitation">
            <strong>{i.name} invited you</strong><small>{formatPlayerCode(i.playerCode)} · Invite lasts 10 minutes</small>
            <div><button className="primary" disabled={busy || !online || (!!party && party.id !== i.partyId)} onClick={() => action("party_accept", { token: i.token })}>Join party</button>
              <button className="secondary" disabled={busy || !online} onClick={() => action("party_decline", { token: i.token })}>Decline</button></div>
            {party && party.id !== i.partyId && <small>Leave your current party before joining this one.</small>}
          </div>)}</section>}
        </>}
        {notice && <p className="party-notice" role="status">{notice}</p>}
      </div>
    </aside>, document.body)}
  </>;
}
