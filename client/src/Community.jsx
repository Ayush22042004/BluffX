import React, { useState, useEffect, useRef } from "react";
import { authRequest } from "./auth";
export default function Community({
  roomId,
  onInvite,
  initial = "friends",
  revision = 0,
}) {
  const [tab, setTab] = useState(initial),
    [data, setData] = useState(null),
    [handle, setHandle] = useState(""),
    [found, setFound] = useState([]),
    [error, setError] = useState(""),
    [page, setPage] = useState(0),
    [busy, setBusy] = useState(false);
  const endpoint =
    tab === "friends"
      ? "social"
      : tab === "recent"
        ? "social/recent"
        : `${tab}?page=${page}`;
  const activeEndpoint = useRef(endpoint);
  activeEndpoint.current = endpoint;
  const load = () =>
    authRequest(endpoint, undefined, "GET")
      .then((d) => {
        if (activeEndpoint.current === endpoint) setData(d);
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    let active = true;
    setData(null);
    setError("");
    authRequest(endpoint, undefined, "GET")
      .then((d) => active && setData(d))
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [tab, page, revision]);
  async function action(path, body) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await authRequest(path, body);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const button = (label, path, body) => (
    <button
      disabled={busy}
      className="secondary"
      onClick={() => action(path, body)}
    >
      {label}
    </button>
  );
  return (
    <section className="community">
      <h2>Your BluffX circle</h2>
      <nav aria-label="Player records">
        {[
          ["friends", "Friends"],
          ["recent", "Recent players"],
          ["history", "Match history"],
          ["achievements", "Achievements"],
          ["season", "Season"],
        ].map(([v, l]) => (
          <button
            className={tab === v ? "primary" : "secondary"}
            key={v}
            onClick={() => {
              setData(null);
              setTab(v);
              setPage(0);
            }}
          >
            {l}
          </button>
        ))}
      </nav>
      {error && <p role="alert">{error}</p>}
      {!data ? (
        <p>Loading player records...</p>
      ) : tab === "friends" ? (
        <>
          <p>
            Your public identifier: <strong>{data.profile.handle}</strong>
          </p>
          <small>
            Share this identifier to receive requests. Email addresses stay
            private.
          </small>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                setFound(
                  (
                    await authRequest(
                      `social/search?handle=${encodeURIComponent(handle)}`,
                      undefined,
                      "GET",
                    )
                  ).players,
                );
              } catch (e) {
                setError(e.message);
              }
            }}
          >
            <label>
              Find a player by exact identifier
              <input
                aria-label="Public player identifier"
                value={handle}
                maxLength={16}
                onChange={(e) => setHandle(e.target.value.trim().toLowerCase())}
              />
            </label>
            <button className="secondary">Search</button>
          </form>
          {found.map((p) => (
            <div className="social-row" key={p.handle}>
              <span>
                {p.name} · {p.handle}
              </span>
              {button("Send request", "social/action", {
                handle: p.handle,
                action: "request",
              })}
            </div>
          ))}
          <h3>Friends and requests</h3>
          {!data.players.length && (
            <p>No friends yet. Share your identifier to get started.</p>
          )}
          {data.players.map((p) => (
            <div className="social-row" key={p.handle}>
              <span>
                <strong>{p.name}</strong>
                <small>
                  {p.status === "accepted"
                    ? "Friend"
                    : p.incoming
                      ? "Incoming request"
                      : "Request sent"}
                </small>
              </span>
              {p.status === "pending" && p.incoming ? (
                <>
                  {button("Accept", "social/action", {
                    handle: p.handle,
                    action: "accept",
                  })}
                  {button("Decline", "social/action", {
                    handle: p.handle,
                    action: "decline",
                  })}
                </>
              ) : p.status === "accepted" ? (
                <>
                  {roomId &&
                    button("Invite to table", "social/invite", {
                      handle: p.handle,
                      roomId,
                    })}
                  {button("Remove friend", "social/action", {
                    handle: p.handle,
                    action: "remove",
                  })}
                </>
              ) : null}
              {button("Block", "social/action", {
                handle: p.handle,
                action: "block",
              })}
            </div>
          ))}
          <h3>Invitations</h3>
          {!data.invites.length && (
            <p>No invitations. Refresh when a friend sends one.</p>
          )}
          {data.invites.map((i) => (
            <div className="social-row" key={i.token}>
              <span>{i.name} invited you</span>
              <button
                className="secondary"
                onClick={async () => {
                  try {
                    const d = await authRequest(
                      `social/invite/${i.token}`,
                      undefined,
                      "GET",
                    );
                    onInvite(d.roomId);
                  } catch (e) {
                    setError(e.message);
                  }
                }}
              >
                Open table
              </button>
            </div>
          ))}
          <h3>Privacy</h3>
          {[
            ["requests_enabled", "requests", "Allow friend requests"],
            ["invites_enabled", "invites", "Allow friend invitations"],
            ["recent_enabled", "recent", "Appear in recent players"],
          ].map(([field, key, label]) => (
            <label className="preference-row" key={field}>
              <input
                type="checkbox"
                checked={!!data.profile[field]}
                onChange={(e) =>
                  action("social/preferences", {
                    requests: data.profile.requests_enabled,
                    invites: data.profile.invites_enabled,
                    recent: data.profile.recent_enabled,
                    [key]: e.target.checked,
                  })
                }
              />
              {label}
            </label>
          ))}
          {data.blocks.map((p) => (
            <div className="social-row" key={p.handle}>
              <span>{p.name} · Blocked</span>
              {button("Unblock", "social/action", {
                handle: p.handle,
                action: "unblock",
              })}
            </div>
          ))}
          <button className="secondary" onClick={load}>
            Refresh
          </button>
        </>
      ) : tab === "recent" ? (
        <>
          <h3>Recent players</h3>
          <p>
            Only players who allow recent-player discovery are shown. No room
            history is shared.
          </p>
          {!data.players?.length && <p>No recent players to show.</p>}
          {data.players?.map((p) => (
            <div className="social-row" key={p.handle}>
              <span>{p.name}</span>
              {button("Send request", "social/action", {
                handle: p.handle,
                action: "request",
              })}
            </div>
          ))}
        </>
      ) : tab === "history" ? (
        <>
          <h3>Your completed matches</h3>
          {!data.items.length && (
            <p>Completed account matches will appear here.</p>
          )}
          {data.items.map((m) => (
            <article className="social-row" key={m.match_id}>
              <div>
                <strong>
                  {m.won ? "Victory" : `Placement ${m.placement}`}
                </strong>
                <small>
                  Winner: {m.winner_name || (m.won ? "You" : "Not recorded")}
                </small>
                {m.participants && (
                  <small>Players: {m.participants.join(", ")}</small>
                )}
                <small>
                  {new Date(Number(m.completed_at)).toLocaleDateString()} ·{" "}
                  {m.mode} · {m.ranked ? "Verified" : "Unranked"}
                  {m.ai_assisted ? " · AI assisted" : ""}
                  {m.forfeit ? " · Forfeit" : ""}
                </small>
                <small>
                  {m.deckCount
                    ? `${m.deckCount} deck(s)`
                    : "Deck mode not recorded"}{" "}
                  · {m.playerCount ?? "Unknown"} players ·{" "}
                  {m.durationMs !== null
                    ? `${Math.round(m.durationMs / 1000)} seconds`
                    : "Duration not recorded"}
                </small>
              </div>
            </article>
          ))}
        </>
      ) : tab === "achievements" ? (
        <>
          <h3>Achievements</h3>
          <p>
            Cosmetic achievements unlock from eligible ranked human matches.
            Practice and unranked playtests do not grant ranked achievements.
          </p>
          {!data.items.length && <p>Your first unlock is still ahead.</p>}
          {data.items.map((a) => (
            <p key={a.achievement}>
              <strong>{a.title}</strong> ·{" "}
              {new Date(Number(a.unlocked_at)).toLocaleDateString()}
            </p>
          ))}
        </>
      ) : (
        <>
          <h3>{data.season?.id || "Current season"}</h3>
          <p>Ranked results only. All-time rankings remain in Leaderboard.</p>
          {!data.items.length && <p>No eligible results this season yet.</p>}
          {data.items.map((p, i) => (
            <p key={i}>
              {p.rank}. {p.name} · {p.wins} wins / {p.games} games ·{" "}
              {p.win_rate}%
            </p>
          ))}
        </>
      )}
      {!["friends", "recent"].includes(tab) && (
        <div className="social-row">
          <button
            disabled={!page}
            className="secondary"
            onClick={() => setPage((p) => p - 1)}
          >
            Previous
          </button>
          <span>Page {page + 1}</span>
          <button
            disabled={!data?.hasMore}
            className="secondary"
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </button>
        </div>
      )}
    </section>
  );
}
