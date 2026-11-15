import React, { useState } from "react";
import { authRequest } from "./auth";
import { socket } from "./lib/socket";
import { BUILD } from "./lib/build";
export { BUILD };
export function PrivacyInfo() {
  return (
    <>
      <h2>Your privacy</h2>
      <p>Player-submitted reports may be forwarded to the configured support inbox, including your account name, Player Code, contact email and description. Do not include passwords, private cards or access tokens. Automatic browser diagnostics do not generate report emails.</p>
      <p>
        Optional social features store a public player identifier, friend
        requests, friendships, blocks, invitations and cosmetic achievement
        unlocks. Friends &amp; Records lets you disable requests, invitations and
        recent-player discovery. History labels hide blocked or non-discoverable
        opponents. Blocking controls social interactions; it does not remove a
        player from an existing match. Invitations expire after ten minutes.
      </p>
      <p>
        BluffX stores your account profile, uploaded avatar, sign-in sessions,
        and server-validated game records in PostgreSQL. Passwords are hashed.
        Your hand and reconnect credentials are never included in public room
        updates.
      </p>
      <p>
        Basic error diagnostics include the app build and an error category,
        never error messages, private cards, microphone audio, or credentials.
      </p>
      <p>
        Voice is optional. Only unmuting opens your microphone; muting releases
        it. BluffX does not record audio. WebRTC connects players directly or
        through the configured relay provider, which processes network traffic.
        Direct connections can reveal network addresses to other participants.
      </p>
      <p>
        Private completed-room snapshots are retained for up to 30 days. Guest
        avatars expire after 30 days; account avatars remain until replaced or
        deleted. Problem reports are retained for up to 30 days. Describe issues
        without pasting passwords, tokens, or private cards.
      </p>
      <p>
        Use My Profile → Delete account to request an email confirmation.
        Deletion revokes sessions, removes your profile and avatar, and
        anonymizes retained match records. Completed competitive outcomes may
        remain without your account identity. Erasure requests retry
        automatically if storage is temporarily unavailable.
      </p>
      <p>
        Room hosts may remove disruptive players. Individual voice volume
        controls can silence another participant. Use Report a problem to report
        abuse. Provider security logs and your browser cache may follow separate
        retention periods.
      </p>
      <p>
        Party membership is saved until you leave or delete your account. Party
        invitations expire after 10 minutes. Party audio continues between games
        until you leave voice, switch channels, or disconnect; it is not recorded.
      </p>
    </>
  );
}
export function ReportProblem() {
  const [category, setCategory] = useState("gameplay"),
    [description, setDescription] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  return (
    <>
      <h2>Report a problem</h2>
      <p>
        Tell us what happened and what you expected. Private cards and
        credentials are not attached.
        If signed in, your account name, Player Code and email are included so support can contact you.
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          setBusy(true);
          setMessage("");
          try {
            const result = await authRequest("report", {
              category,
              description,
              socketId: socket.id,
              build: BUILD,
            });
            setMessage(`Report saved. Reference: ${result.id}`);
            setDescription("");
          } catch (err) {
            setMessage(err.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="field">
          Category
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            {["gameplay", "voice", "connection", "abuse", "other"].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
        <label className="field">
          What happened?
          <textarea
            aria-label="Problem description"
            minLength={10}
            maxLength={2000}
            required
            rows={5}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <button
          className="primary"
          disabled={busy || description.trim().length < 10}
        >
          {busy ? "Sending…" : "Send report"}
        </button>
      </form>
      {message && <p role="status">{message}</p>}
      <small>Build {BUILD}</small>
    </>
  );
}
export function ConfirmDeletion({ token, onDone }) {
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [done, setDone] = useState(false);
  return (
    <main className="auth-loading account-erasure">
      <h1>Delete your account?</h1>
      <p>
        This removes your profile and avatar, signs out all devices, and
        anonymizes retained match records. This cannot be undone.
      </p>
      {!done && (
        <button
          className="primary"
          disabled={busy}
          onClick={async () => {
            if (busy) return;
            setBusy(true);
            try {
              const result = await authRequest("confirm-account-deletion", {
                token,
              });
              setMessage(result.message);
              setDone(true);
            } catch (e) {
              setMessage(e.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Deleting…" : "Permanently delete my account"}
        </button>
      )}
      <p role="status">{message}</p>
      <button className="secondary" onClick={() => onDone(done)}>
        {done ? "Return to sign in" : "Cancel"}
      </button>
    </main>
  );
}
