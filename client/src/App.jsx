import React, { useEffect, useRef, useState } from "react";
import { socket, sendGameAction } from "./lib/socket";
import TutorialGame from "./TutorialGame";
import VoiceChat from "./VoiceChat";
import { BetaVersion } from "./DisplayHints";
import Community from "./Community";
import Preferences, { readPreferences, applyPreferences } from "./Preferences";
import { BUILD, PrivacyInfo, ReportProblem } from "./LaunchTools";
import Deadline from "./Deadline";
import { synchronizeClock } from "./lib/clock";
import { prepareAvatar, uploadAvatar } from "./lib/avatar-upload";
import { clockwiseSeats, opponentPosition } from "./lib/seating";
import { useAuth, authRequest } from "./auth";
import {
  Icon,
  Mask,
  Avatar,
  Back,
  HandFan,
  Fan,
  Field,
  Segments,
  Stat,
  Action,
  Chat,
  Challenge,
  RoundResult,
  Results,
  rankName,
  RankPicker,
} from "./components";
const emptyStats = { games: 0, wins: 0, calls: 0, correct: 0 };
function read(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) || fallback;
  } catch {
    return fallback;
  }
}
export default function App() {
  const {
    user: account,
    setUser: setAccount,
    config: authConfig,
    logout,
    openLogin,
  } = useAuth();
  useEffect(() => applyPreferences(readPreferences()), []);
  const [socialRevision, setSocialRevision] = useState(0);
  useEffect(() => {
    const fn = () => setSocialRevision((n) => n + 1);
    socket.on("social_updated", fn);
    return () => socket.off("social_updated", fn);
  }, []);
  const [slowConnection, setSlowConnection] = useState(false);
  useEffect(() => {
    const fn = (e) => setSlowConnection(!!e.detail.slow);
    window.addEventListener("bluffx:network", fn);
    return () => window.removeEventListener("bluffx:network", fn);
  }, []);
  const [accountNotice, setAccountNotice] = useState("");
  const [kickTarget, setKickTarget] = useState(null);
  const [tutorialBusy, setTutorialBusy] = useState(false);
  const [profile, setProfile] = useState(() =>
    account
      ? {
          name: account.name,
          avatar: account.avatar,
          avatarId: account.avatarId || null,
        }
      : read("bluffx:profile", {
          name: localStorage.getItem("bluffx:name") || "",
          avatar: 0,
        }),
  );
  const [draft, setDraft] = useState(profile),
    [stats, setStats] = useState(emptyStats);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const avatarPreviewRequest = useRef(0);
  const [leaders, setLeaders] = useState({
    players: [],
    total: 0,
    page: 0,
    limit: 20,
  });
  const [leaderRevision, setLeaderRevision] = useState(0);
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const seenVersion = useRef({ roomId: null, version: -1 });
  const lastStatsMatch = useRef(null);
  const statsFetch = useRef(0);
  const priorController = useRef(null);
  const refreshStats = () => {
    const sequence = ++statsFetch.current;
    return account
      ? authRequest("stats", undefined, "GET")
          .then((data) => {
            if (sequence === statsFetch.current) setStats(data.stats);
          })
          .catch(() => {})
      : Promise.resolve(setStats(emptyStats));
  };
  const refreshResultStats = (matchId) => {
    if (matchId && lastStatsMatch.current === matchId) return;
    lastStatsMatch.current = matchId;
    refreshStats();
    setLeaderRevision((n) => n + 1);
  };
  const [screen, setScreen] = useState("home"),
    [state, setState] = useState(null),
    [connected, setConnected] = useState(socket.connected),
    [error, setError] = useState(""),
    [modal, setModal] = useState(
      account && (account.tutorialStatus || "new") === "new"
        ? "tutorial-offer"
        : null,
    ),
    [selected, setSelected] = useState([]),
    [handExpanded, setHandExpanded] = useState(false),
    [rank, setRank] = useState("J"),
    [history, setHistory] = useState([]),
    [messages, setMessages] = useState([]);
  const [botCount, setBotCount] = useState(3),
    [maxPlayers, setMaxPlayers] = useState(4),
    [deckCount, setDeckCount] = useState(1),
    [preset, setPreset] = useState("classic"),
    [voiceEnabled, setVoiceEnabled] = useState(true),
    [aiStyle, setAiStyle] = useState("balanced"),
    [turnSeconds, setTurnSeconds] = useState(30),
    [roomName, setRoomName] = useState(""),
    [password, setPassword] = useState(""),
    [privacy, setPrivacy] = useState("Public"),
    [code, setCode] = useState(""),
    [busy, setBusy] = useState(false);
  const prevPhase = useRef(null),
    chatRef = useRef(null);
  useEffect(() => {
    refreshStats();
  }, [account?.id]);
  useEffect(() => {
    if (modal === "scores")
      authRequest(`leaderboard?page=${leaders.page}&limit=20`, undefined, "GET")
        .then(setLeaders)
        .catch(() => setError("Leaderboard is temporarily unavailable."));
  }, [modal, leaders.page, leaderRevision]);
  useEffect(() => {
    const onState = (s) => {
      if (
        seenVersion.current.roomId === s.roomId &&
        s.version < seenVersion.current.version
      )
        return;
      seenVersion.current = { roomId: s.roomId, version: s.version };
      synchronizeClock(s.serverNow);
      setSyncing(false);
      setStorageUnavailable(false);
      setBusy(false);
      if (!s.you?.aiTakeover && !s.you?.afkStrikes) setError("");
      setState(s);
      const previous = priorController.current;
      if (s.you?.aiTakeover && !previous?.ai)
        setError("AI is temporarily playing your hand.");
      else if (previous?.ai && !s.you?.aiTakeover)
        setError("You're back in control.");
      else if (s.you?.afkStrikes > (previous?.strikes || 0))
        setError(
          s.you.controllerState === "HUMAN_AFK_FINAL_WARNING"
            ? "Final warning: Your next missed turn activates AI."
            : "You missed your turn. Are you still playing?",
        );
      priorController.current = {
        ai: !!s.you?.aiTakeover,
        strikes: s.you?.afkStrikes || 0,
      };
      // A recovery may finish while no client is connected to receive stats_updated.
      if (s.phase === "finished") refreshResultStats(s.matchId);
      setSelected((ids) => {
        const kept = ids.filter((id) => s.hand.some((c) => c.id === id));
        return kept.length === ids.length ? ids : kept;
      });
      if (s.phase === "playing" && prevPhase.current === "finished") {
        setHistory([]);
        setMessages([]);
      }
      prevPhase.current = s.phase;
    };
    const onResult = (p) =>
      setHistory((h) =>
        [
          {
            id: crypto.randomUUID(),
            text: p.message,
            tone: p.type === "caller_correct" ? "pink" : "green",
          },
          ...h,
        ].slice(0, 60),
      );
    const onError = (p) => {
      setError(p.message);
      setBusy(false);
    };
    const onConnect = () => setConnected(true);
    const onDisconnect = () => {
      setConnected(false);
      setSyncing(true);
      setBusy(false);
      setModal(null);
      setError("Connection lost. Reconnecting to your saved seat...");
    };
    const onLeft = () => {
      setState(null);
      setScreen("home");
      setHistory([]);
      setMessages([]);
      setSelected([]);
      setModal(null);
    };
    const onRemoved = (p) => {
      onLeft();
      setError(p.message || "Your previous seat expired.");
    };
    const onReplaced = (p) => {
      onLeft();
      socket.disconnect();
      setError(p.message);
    };
    const onStats = (event) => refreshResultStats(event?.matchId);
    const onStorage = (status) => setStorageUnavailable(!status.available);
    const onReady = () => setSyncing(false);
    const onChat = (m) => setMessages((list) => [...list, m].slice(-100));
    socket.on("stats_updated", onStats);
    socket.on("storage_status", onStorage);
    socket.on("server_ready", onReady);
    socket.on("room_state", onState);
    socket.on("bluff_result", onResult);
    socket.on("action_error", onError);
    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("room_left", onLeft);
    socket.on("chat_message", onChat);
    socket.on("room_removed", onRemoved);
    socket.on("seat_expired", onRemoved);
    socket.on("seat_replaced", onReplaced);
    return () => {
      socket.off("stats_updated", onStats);
      socket.off("storage_status", onStorage);
      socket.off("server_ready", onReady);
      socket.off("room_state", onState);
      socket.off("bluff_result", onResult);
      socket.off("action_error", onError);
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("room_left", onLeft);
      socket.off("chat_message", onChat);
      socket.off("room_removed", onRemoved);
      socket.off("seat_expired", onRemoved);
      socket.off("seat_replaced", onReplaced);
    };
  }, []);
  useEffect(() => {
    const move = state?.lastMove;
    if (move)
      setHistory((h) =>
        [
          {
            id: `claim-${move.ts}`,
            text: `${move.playerName} claimed ${move.cardCount} ${rankName(move.declaredRank)}.`,
            tone: "purple",
          },
          ...h,
        ].slice(0, 60),
      );
  }, [state?.lastMove?.ts]);
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(""), 5000);
    return () => clearTimeout(t);
  }, [error]);
  useEffect(() => {
    if (chatRef.current)
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [messages]);
  useEffect(() => {
    if (!busy) return;
    const t = setTimeout(() => {
      setBusy(false);
      setError(
        "The server did not respond. Check your connection and try again.",
      );
    }, 8000);
    return () => clearTimeout(t);
  }, [busy]);
  useEffect(() => {
    if (!state?.presenceEvents?.length) return;
    setHistory((history) => {
      const seen = new Set();
      return [
        ...state.presenceEvents
          .slice()
          .reverse()
          .map((e) => ({ id: e.id, text: e.message, tone: "gold" })),
        ...history,
      ]
        .filter((e) => !seen.has(e.id) && seen.add(e.id))
        .slice(0, 60);
    });
  }, [state?.presenceEvents?.at(-1)?.id]);
  const me = state?.you || {
      ...profile,
      id: "me",
      name: profile.name || "Player",
    },
    players = state?.players || [],
    playing = state?.phase === "playing",
    mine =
      playing &&
      connected &&
      !storageUnavailable &&
      !syncing &&
      !me.aiTakeover &&
      !state.pause &&
      state.currentTurnId === me.id,
    claim = state?.lastMove,
    count = (p) => state?.playerHandsCount[p.id] || 0,
    host = state?.hostId === me.id;
  const request = (event, data, snapshot = null) =>
    sendGameAction(event, data, snapshot).then((result) => {
      if (!result?.ok) {
        setBusy(false);
        setError(result?.message || "Unable to confirm that action.");
      }
      return result;
    });
  const emit = (event, extra = {}) =>
    request(event, { roomId: state?.roomId, ...extra }, state);
  const go = (target) => {
    if (state) {
      if (target === "profile") {
        setDraft(profile);
        setModal("profile");
      } else setError("Leave the current table to open another screen.");
      return;
    }
    setScreen(target);
    setModal(null);
    if (target === "profile") setDraft(profile);
  };
  const saveProfile = async () => {
    if (profileSaving || avatarBusy) return;
    const name = draft.name.trim();
    if (!name) return setError("Please choose your player name.");
    setProfileSaving(true);
    try {
      const next = {
        name: name.slice(0, 20),
        avatar: draft.avatar,
        avatarId: draft.avatarId || null,
      };
      if (draft.avatarPreview) {
        setAvatarBusy(true);
        try {
          next.avatarId = await uploadAvatar(draft.avatarPreview);
        } catch (error) {
          setError(error.message);
          return;
        } finally {
          setAvatarBusy(false);
        }
      }
      if (account) {
        try {
          const data = await authRequest("profile", next, "PATCH");
          setAccount(data.user);
          next.avatarId = data.user.avatarId || null;
        } catch (error) {
          setError(error.message);
          return;
        }
      } else {
        localStorage.setItem("bluffx:profile", JSON.stringify(next));
        localStorage.setItem("bluffx:name", next.name);
      }
      setProfile(next);
      setDraft(next);
      if (connected) emit("update_profile", next);
      setError("Profile saved.");
      if (modal === "profile") setModal(null);
    } finally {
      setProfileSaving(false);
    }
  };
  const enter = (ai) => {
    if (!profile.name.trim()) {
      setDraft(profile);
      setError("Set your player name before taking a seat.");
      setScreen("profile");
      return;
    }
    if (!connected) return setError("Waiting for the game server to connect.");
    setBusy(true);
    setHistory([]);
    setMessages([]);
    request(ai ? "create_ai_room" : "create_room", {
      ...profile,
      botCount,
      deckCount,
      preset,
      voiceEnabled,
      aiStyle,
      maxPlayers,
      turnSeconds,
      roomName: roomName.trim() || `${profile.name}'s Bluff Arena`,
      password: privacy === "Private" ? password : "",
    });
  };
  const join = (e) => {
    e.preventDefault();
    if (!profile.name.trim()) {
      go("profile");
      return setError("Choose a player name, then join your friends.");
    }
    if (!connected) return setError("Waiting for the game server to connect.");
    if (!code.trim()) return setError("Enter your room code.");
    setBusy(true);
    request("join_room", { ...profile, roomId: code, password });
  };
  useEffect(() => {
    const invite = new URLSearchParams(location.search).get("room");
    if (/^[A-F0-9]{6}$/i.test(invite || "")) {
      setCode(invite.toUpperCase());
      setScreen("join");
    }
  }, []);
  const copyInvite = () =>
    navigator.clipboard
      ?.writeText(`${location.origin}/?room=${state.roomId}`)
      .then(() =>
        setError(
          "Invitation link copied. Private tables still require a password.",
        ),
      )
      .catch(() => setError(`Room code: ${state.roomId}`));
  const copy = () =>
    navigator.clipboard
      ?.writeText(state.roomId)
      .then(() => setError("Room code copied."))
      .catch(() => setError(`Room code: ${state.roomId}`));
  const leave = () => {
    emit("leave_room");
    setModal(null);
  };
  const saveTutorial = async (status) => {
    if (tutorialBusy) return;
    setTutorialBusy(true);
    try {
      if (account) {
        const data = await authRequest("tutorial", { status });
        setAccount(data.user);
      }
      setModal(null);
      if (status === "completed")
        setError("Tutorial complete. Your next table is waiting!");
    } catch (error) {
      setError(error.message);
    } finally {
      setTutorialBusy(false);
    }
  };
  const closeModal = () => {
    if (
      modal === "tutorial-offer" ||
      (modal === "tutorial" && account?.tutorialStatus === "new")
    )
      saveTutorial("skipped");
    else setModal(null);
  };
  const profileContent = (
    <>
      <div className="section-heading">
        <Icon name="user" size={35} />
        <div>
          <h1>My Profile</h1>
          <p>Your identity at every table.</p>
        </div>
      </div>
      <div className="profile-editor">
        <Avatar player={draft} large />
        <Field label="Player name">
          <input
            autoComplete="nickname"
            maxLength={20}
            value={draft.name}
            placeholder="What should we call you?"
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          />
        </Field>
        <Field label="Choose your avatar">
          <div className="avatar-options">
            {[0, 1, 2, 3, 4, 5].map((avatar) => (
              <button
                type="button"
                key={avatar}
                className={
                  draft.avatar === avatar &&
                  !draft.avatarId &&
                  !draft.avatarPreview
                    ? "selected"
                    : ""
                }
                aria-label={`Avatar ${avatar + 1}`}
                aria-pressed={
                  draft.avatar === avatar &&
                  !draft.avatarId &&
                  !draft.avatarPreview
                }
                onClick={() => {
                  avatarPreviewRequest.current++;
                  setDraft((d) => ({
                    ...d,
                    avatar,
                    avatarId: null,
                    avatarPreview: null,
                  }));
                }}
              >
                <Avatar player={{ avatar }} />
              </button>
            ))}
          </div>
          <label className="secondary avatar-upload-button">
            <Icon name="user" size={18} />{" "}
            {avatarBusy ? "Preparing photo..." : "Upload your own photo"}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              aria-label="Upload avatar photo"
              disabled={avatarBusy || profileSaving}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                const request = ++avatarPreviewRequest.current;
                setAvatarBusy(true);
                try {
                  const preview = await prepareAvatar(file);
                  if (request === avatarPreviewRequest.current)
                    setDraft((d) => ({
                      ...d,
                      avatarPreview: preview,
                      avatarId: null,
                    }));
                } catch (error) {
                  setError(error.message);
                } finally {
                  setAvatarBusy(false);
                }
              }}
            />
          </label>
          <small className="field-hint">
            PNG, JPEG or WebP, up to 5 MB. Your photo is cropped to a square.
          </small>
        </Field>
        <button
          className="primary wide"
          onClick={saveProfile}
          disabled={avatarBusy || profileSaving}
        >
          <Icon name="check" />
          Save Profile
        </button>
        <p className="muted fine">
          {account
            ? "Saved to your BluffX account. Change your name and avatar at any time."
            : "Saved on this browser. Sign in to keep your player profile."}
        </p>
        <div className="account-section">
          {account && (
            <button
              className="secondary"
              onClick={async () => {
                try {
                  const result = await authRequest(
                    "request-account-deletion",
                    {},
                  );
                  setAccountNotice(result.message);
                } catch (e) {
                  setAccountNotice(e.message);
                }
              }}
            >
              Delete account
            </button>
          )}
          {account ? (
            <>
              <div className="account-identity">
                <Icon name="user" size={20} />
                <div>
                  <strong>{account.email}</strong>
                  <small className={account.emailVerified ? "green" : "gold"}>
                    {account.emailVerified
                      ? "Email verified"
                      : "Email verification pending"}
                  </small>
                </div>
              </div>
              {!account.emailVerified && (
                <button
                  className="secondary wide"
                  onClick={async () => {
                    try {
                      const data = await authRequest("resend-verification", {});
                      setAccountNotice(
                        authConfig?.emailDelivery === "local"
                          ? "Verification email saved to the local server outbox."
                          : data.message,
                      );
                    } catch (e) {
                      setAccountNotice(e.message);
                    }
                  }}
                >
                  Resend Verification Email
                </button>
              )}
              {accountNotice && (
                <p className="fine" role="status">
                  {accountNotice}
                </p>
              )}
              <button
                className="account-signout"
                onClick={async () => {
                  try {
                    await logout();
                  } catch (e) {
                    setError(e.message);
                  }
                }}
              >
                Sign Out
              </button>
            </>
          ) : (
            <button className="secondary wide" onClick={openLogin}>
              <Icon name="user" size={18} />
              Sign In / Create Account
            </button>
          )}
        </div>
      </div>
    </>
  );
  const sidebar = (
    <aside className="home-sidebar">
      <section className="panel">
        <div className="profile-summary">
          <Avatar player={me} large onClick={() => go("profile")} />
          <div>
            <h2>{profile.name || "Your next alias?"}</h2>
            <p className="pink-text">
              {profile.name ? "Welcome to the club" : "Create your profile"}
            </p>
            <small>
              {stats.games} games · {stats.wins} wins
            </small>
          </div>
        </div>
        <div className="side-nav">
          {[
            ["home", "Home", "home"],
            ["profile", "My Profile", "user"],
            ["ai", "Play with AI", "bolt"],
            ["create", "Create Room", "users"],
            ["join", "Join Room", "join"],
          ].map(([target, label, icon]) => (
            <button
              key={target}
              className={screen === target ? "active" : ""}
              onClick={() => go(target)}
            >
              <Icon name={icon} />
              {label}
              <Icon name="arrow" size={16} />
            </button>
          ))}
        </div>
      </section>
      <section className="panel club-note">
        <Mask size={48} />
        <h2>
          A great bluff
          <br />
          starts with you.
        </h2>
        <p>
          Pick a name. Find your table.
          <br />
          Keep them guessing.
        </p>
        <button className="secondary" onClick={() => go("profile")}>
          Edit My Profile
          <Icon name="arrow" size={18} />
        </button>
      </section>
    </aside>
  );
  const chat = (
    <>
      <VoiceChat state={state?.voiceEnabled === false ? null : state} />
      <Chat
        messages={messages}
        chatRef={chatRef}
        enabled={!!state}
        onSend={(text) => emit("send_chat", { text })}
        title={state?.phase === "lobby" ? "Lobby Chat" : "Table Talk"}
      />
    </>
  );
  const gameSidebar = (
    <aside className="left">
      <section className="panel room-panel">
        <div className="eyebrow">
          <Icon name="cards" size={20} />
          Room Code
          <button className="copy" aria-label="Copy room code" onClick={copy}>
            <Icon name="copy" size={18} />
          </button>
        </div>
        <div className="room-code">{state?.roomId}</div>
        <div className="mode">
          <Mask size={37} />
          <div>
            <small>{state?.roomName}</small>
            <strong>Classic Bluff</strong>
            <small>Claim · Play · Call the Bluff</small>
          </div>
        </div>
        <Stat label="Round" icon="flag" value={state?.roundNumber} />
        <Stat
          label="Current Rank"
          icon="cards"
          value={
            <span className="gold">
              {state?.roundRank
                ? `${rankName(state.roundRank)} (${state.roundRank})`
                : "Your choice"}
            </span>
          }
        />
        <Stat
          label="Turn"
          icon="user"
          value={
            state?.phase === "round_result"
              ? "Complete"
              : state?.phase === "lobby"
                ? "Waiting"
                : state?.currentTurnName
          }
        />
      </section>
      <section className="panel player-panel">
        <h3>
          <Icon name="users" />
          Players ({players.length}/{state?.maxPlayers})
        </h3>
        <p className="turn-order-note">↻ Clockwise turn order</p>
        {players.map((p) => (
          <div
            className={`player-row ${playing && p.id === state.currentTurnId ? "active" : ""}`}
            key={p.id}
          >
            <Avatar player={p} />
            <div>
              <strong>
                <span className="seat-number">
                  {p.seatNumber || players.indexOf(p) + 1}
                </span>{" "}
                {p.id === me.id ? `You (${p.name})` : p.name}{" "}
                {p.id === state.hostId && <Icon name="crown" size={14} />}
              </strong>
              <small>
                {state.phase === "lobby" ? (
                  <span className={p.ready ? "green" : "gold"}>
                    {p.ready ? "✓ Ready" : "◷ Not ready"}
                  </span>
                ) : (
                  `${count(p)} cards`
                )}
                {p.isBot ? " · AI" : ""}
              </small>
              {!p.isBot && p.connected === false && (
                <small className="presence-label">
                  {p.aiTakeover
                    ? `AI playing - ${p.aiRoundsRemaining} rounds left`
                    : "Offline - reconnecting"}
                </small>
              )}
            </div>
            {playing && p.id === state.currentTurnId && (
              <span className="turn-tag">Turn</span>
            )}
            {host && p.id !== me.id && !p.isBot && (
              <button
                className="kick-player"
                aria-label={`Remove ${p.name}`}
                onClick={() => {
                  setKickTarget(p.id);
                  setModal("kick");
                }}
              >
                Remove
              </button>
            )}
          </div>
        ))}
        <button className="leave-button" onClick={() => setModal("leave")}>
          <Icon name="back" size={16} />
          Leave table
        </button>
      </section>
      {playing && (
        <section className="panel pressure">
          <h3>
            <Mask size={24} />
            Group Suspicion
          </h3>
          <div className="meter">
            <i
              style={{
                width: `${Math.min(100, (claim?.cardCount || 0) * 22)}%`,
              }}
            />
          </div>
          <small>
            {claim
              ? `${claim.cardCount} cards claimed. Trust your instincts.`
              : "Who makes the first move?"}
          </small>
        </section>
      )}
    </aside>
  );
  return (
    <div className={`app ${state ? "at-table" : ""}`}>
      <header>
        <button
          className="brand"
          aria-label="BluffX home"
          onClick={() => !state && go("home")}
        >
          <img
            className="brand-icon"
            src="/bluffx.ico"
            alt=""
            width="42"
            height="42"
          />
          Bluff<span>X</span>
          <BetaVersion />
        </button>
        <nav>
          <button
            aria-label="Play"
            className={
              !state && ["home", "ai", "join"].includes(screen) ? "active" : ""
            }
            onClick={() => go("home")}
          >
            <Icon name="play" />
            <span>Play</span>
          </button>
          <button
            aria-label="Create Room"
            className={!state && screen === "create" ? "active" : ""}
            onClick={() => go("create")}
          >
            <Icon name="users" />
            <span>Create Room</span>
          </button>
          <button aria-label="Leaderboard" onClick={() => setModal("scores")}>
            <Icon name="trophy" />
            <span>Leaderboard</span>
          </button>
          <button aria-label="How to Play" onClick={() => setModal("help")}>
            <Icon name="book" />
            <span>How to Play</span>
          </button>
        </nav>
        <button className="header-profile" onClick={() => go("profile")}>
          <Avatar player={me} />
          <div>
            <strong>
              {profile.name ? `You (${me.name})` : "Create Profile"}
            </strong>
            <small className={connected ? "green" : "gold"}>
              ● {connected ? "Online" : "Connecting"}
            </small>
          </div>
          <span>⌄</span>
        </button>
      </header>
      {state &&
        (!connected ||
          syncing ||
          storageUnavailable ||
          state.pause ||
          players.some((p) => p.aiTakeover || p.afkStrikes)) && (
          <div className="presence-banner" role="status">
            {storageUnavailable ? (
              "Game storage is unavailable. Moves are paused until synchronization succeeds."
            ) : syncing ? (
              "Recovering your saved table..."
            ) : !connected ? (
              "You are offline. Reconnecting to your seat..."
            ) : state.pause ? (
              <>
                Clock paused -{" "}
                {players
                  .filter((p) => p.graceUntil)
                  .map((p) => p.name)
                  .join(", ")}{" "}
                offline - <Deadline deadline={state.pause.until} /> to return
              </>
            ) : (
              players
                .filter((p) => p.aiTakeover || p.afkStrikes)
                .map((p) =>
                  p.aiTakeover
                    ? `AI is playing for ${p.name} - ${p.aiRoundsRemaining} rounds remaining`
                    : `${p.name}: ${p.controllerState === "HUMAN_AFK_FINAL_WARNING" ? "Final Warning - One more missed turn triggers AI takeover." : "Possibly AFK"}`,
                )
                .join(" | ")
            )}
            {me.aiTakeover && me.connected && (
              <button
                className="primary"
                onClick={() => emit("reclaim_control")}
              >
                I’m Back — Take Control
              </button>
            )}
          </div>
        )}
      {!state ? (
        <main className={`menu-layout screen-${screen}`}>
          {sidebar}
          <section className="menu-content">
            {screen === "home" ? (
              <>
                <div className="home-title">
                  <Fan />
                  <p className="overline">WELCOME TO THE BLUFFX SOCIAL CLUB</p>
                  <h1>
                    Trust no one.
                    <br />
                    <em>Play everyone.</em>
                  </h1>
                </div>
                <div className="home-actions">
                  <Action
                    icon="bolt"
                    title="Play with AI"
                    description="Choose your opponents. Sharpen your poker face."
                    onClick={() => go("ai")}
                  />
                  <Action
                    icon="users"
                    title="Create Room"
                    description="Set up your table and invite your friends."
                    tone="purple"
                    onClick={() => go("create")}
                  />
                  <Action
                    icon="join"
                    title="Join Room"
                    description="Got a room code? Your seat is waiting."
                    onClick={() => go("join")}
                  />
                </div>
                <div className="home-deck">
                  <Back />
                  <span>THE NEXT MOVE IS YOURS</span>
                </div>
              </>
            ) : screen === "profile" ? (
              <section className="panel profile-page">{profileContent}</section>
            ) : screen === "ai" || screen === "create" ? (
              <section className="panel setup-panel">
                <div className="section-heading">
                  <Icon name={screen === "ai" ? "bolt" : "users"} size={42} />
                  <div>
                    <h1>{screen === "ai" ? "Play with AI" : "Create Room"}</h1>
                    <p>
                      {screen === "ai"
                        ? "Your pace. Your opponents. Your next great bluff."
                        : "Set up a new BluffX room and invite your friends."}
                    </p>
                  </div>
                </div>
                <div className="setup-fields">
                  <Field label="Your player">
                    <button
                      className="player-choice"
                      onClick={() => go("profile")}
                    >
                      <Avatar player={me} />
                      <strong>{profile.name || "Choose your name"}</strong>
                      <span>Edit profile →</span>
                    </button>
                  </Field>
                  <Field label="Room name">
                    <input
                      maxLength={32}
                      value={roomName}
                      placeholder={`${profile.name || "Your"}'s Bluff Arena`}
                      onChange={(e) => setRoomName(e.target.value)}
                    />
                  </Field>
                  <Field label="Match preset">
                    <select
                      aria-label="Match preset"
                      value={preset}
                      onChange={(e) => {
                        const v = e.target.value;
                        setPreset(v);
                        if (v !== "custom") {
                          setMaxPlayers(v === "party" ? 10 : 4);
                          setDeckCount(v === "party" ? 2 : 1);
                          setTurnSeconds(v === "classic" ? 30 : 20);
                        }
                      }}
                    >
                      <option value="classic">Classic - balanced table</option>
                      <option value="party">Party - larger groups</option>
                      <option value="quick">Quick Match - faster turns</option>
                      <option value="custom">Custom</option>
                    </select>
                  </Field>
                  <Field label="Game mode">
                    <div className="mode-choice">
                      <Mask size={34} />
                      <strong>Classic Bluff</strong>
                      <small>Claim · Play · Call the Bluff</small>
                      <Icon name="check" size={20} />
                    </div>
                  </Field>
                  <Field
                    label={screen === "ai" ? "AI opponents" : "Maximum players"}
                  >
                    <Segments
                      label={
                        screen === "ai"
                          ? "AI opponent count"
                          : "Maximum players"
                      }
                      values={
                        screen === "ai"
                          ? [1, 2, 3, 4, 5]
                          : [2, 3, 4, 5, 6, 7, 8, 9, 10]
                      }
                      value={screen === "ai" ? botCount : maxPlayers}
                      onChange={screen === "ai" ? setBotCount : setMaxPlayers}
                    />
                    <small className="field-hint">
                      {screen === "ai"
                        ? `${botCount} AI opponent${botCount > 1 ? "s" : ""} + you · ${botCount + 1} players total`
                        : "Total seats, including you"}
                    </small>
                  </Field>
                  <Field label="Decks">
                    <Segments
                      label="Deck count"
                      values={["One deck", "Two decks"]}
                      value={deckCount === 2 ? "Two decks" : "One deck"}
                      onChange={(v) => setDeckCount(v === "Two decks" ? 2 : 1)}
                    />
                    <small className="field-hint">
                      {deckCount * 52} cards.{" "}
                      {(screen === "ai" ? botCount + 1 : maxPlayers) >= 6
                        ? "Two decks recommended for six or more seats."
                        : "One deck recommended for smaller tables."}{" "}
                      Your choice stays in effect.
                    </small>
                  </Field>
                  <Field label="Table voice">
                    <label className="voice-toggle">
                      <input
                        type="checkbox"
                        checked={voiceEnabled}
                        onChange={(e) => setVoiceEnabled(e.target.checked)}
                      />{" "}
                      <span><strong>Allow optional voice chat</strong><small>Players choose when to join and turn on their mic.</small></span>
                    </label>
                  </Field>
                  {screen === "ai" && (
                    <Field label="AI playstyle">
                      <select
                        aria-label="AI playstyle"
                        value={aiStyle}
                        onChange={(e) => setAiStyle(e.target.value)}
                      >
                        <option value="casual">Casual</option>
                        <option value="balanced">Balanced</option>
                        <option value="aggressive">Aggressive</option>
                      </select>
                      <small>
                        Styles change risk-taking, never access to hidden cards.
                      </small>
                    </Field>
                  )}
                  <Field label="Time per turn">
                    <Segments
                      label="Turn duration"
                      values={[20, 30, 45, 60]}
                      value={turnSeconds}
                      onChange={setTurnSeconds}
                    />
                    <small className="field-hint">
                      Seconds to decide. All {deckCount * 52} cards are dealt.
                    </small>
                  </Field>
                  {screen === "create" && (
                    <>
                      <Field label="Room privacy">
                        <Segments
                          label="Room privacy"
                          values={["Public", "Private"]}
                          value={privacy}
                          onChange={setPrivacy}
                        />
                      </Field>
                      {privacy === "Private" && (
                        <Field label="Room password">
                          <input
                            type="password"
                            value={password}
                            maxLength={64}
                            onChange={(e) => setPassword(e.target.value)}
                            placeholder="Optional password"
                          />
                        </Field>
                      )}
                    </>
                  )}
                  <button
                    className="primary wide start-button"
                    disabled={busy || !connected}
                    onClick={() => enter(screen === "ai")}
                  >
                    <Icon name={screen === "ai" ? "play" : "users"} />
                    {busy
                      ? "Setting your table…"
                      : screen === "ai"
                        ? "Create AI Table"
                        : "Create Room"}
                  </button>
                </div>
              </section>
            ) : (
              <section className="join-page">
                <Fan />
                <h1>Join Room</h1>
                <p>
                  Have a room code? Your friends are waiting.
                  <br />
                  Enter it below and let the mind games begin.
                </p>
                <form onSubmit={join}>
                  <div className="join-code">
                    <Icon name="lock" size={32} />
                    <input
                      aria-label="Room code"
                      placeholder="ROOM CODE"
                      value={code}
                      maxLength={6}
                      onChange={(e) => setCode(e.target.value.toUpperCase())}
                    />
                  </div>
                  <Field label="Password (if required)">
                    <input
                      aria-label="Room password"
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  </Field>
                  <button
                    className="primary wide"
                    disabled={busy || !connected}
                  >
                    <Icon name="join" />
                    {busy ? "Finding your seat…" : "Join Room"}
                  </button>
                </form>
                <div className="divider">OR</div>
                <button className="secondary wide" onClick={() => go("create")}>
                  <Icon name="users" />
                  Create your own room
                </button>
              </section>
            )}
          </section>
          <aside className="menu-right">
            {screen === "home" ? (
              <>
                <section className="panel personal-stats">
                  <h3>
                    <Icon name="trophy" />
                    Your Record
                  </h3>
                  <div className="record-grid">
                    <div>
                      <strong>{stats.games}</strong>
                      <small>Games played</small>
                    </div>
                    <div>
                      <strong>{stats.wins}</strong>
                      <small>Games won</small>
                    </div>
                    <div>
                      <strong>
                        {stats.games
                          ? Math.round((stats.wins / stats.games) * 100)
                          : 0}
                        %
                      </strong>
                      <small>Win rate</small>
                    </div>
                    <div>
                      <strong>{stats.correct}</strong>
                      <small>Bluffs caught</small>
                    </div>
                  </div>
                  <p className="muted fine">
                    {account
                      ? "Verified ranked results across devices."
                      : "Sign in to build a verified ranked record."}
                  </p>
                </section>
                <section className="panel how-card">
                  <Mask size={55} />
                  <h2>
                    Good cards help.
                    <br />A good bluff wins.
                  </h2>
                  <p>
                    Play face down. Make your claim. Challenge when the story
                    doesn't add up.
                  </p>
                  <button
                    className="secondary wide"
                    onClick={() => setModal("help")}
                  >
                    Learn the rules
                    <Icon name="arrow" size={18} />
                  </button>
                </section>
              </>
            ) : screen === "profile" ? (
              <section className="panel personal-stats">
                <h3>
                  <Icon name="trophy" />
                  Player Stats
                </h3>
                <Stat label="Games played" value={stats.games} icon="cards" />
                <Stat label="Wins" value={stats.wins} icon="trophy" />
                <Stat label="Challenges made" value={stats.calls} icon="eye" />
                <Stat
                  label="Bluffs caught"
                  value={stats.correct}
                  icon="check"
                />
              </section>
            ) : (
              <section className="panel preview-panel">
                <h3>
                  <Icon name="eye" />
                  Room Preview
                </h3>
                <div className="room-preview">
                  <span className="overline">BLUFFX ROOM</span>
                  <h2>
                    {roomName || `${profile.name || "Your"}'s Bluff Arena`}
                  </h2>
                  <div className="preview-code">
                    {screen === "join" ? code || "••••••" : "YOUR CODE"}
                    <small>
                      {screen === "join"
                        ? "Enter the code from your host"
                        : "Generated when you create a room"}
                    </small>
                  </div>
                  <Fan />
                  <div className="preview-badges">
                    <span>
                      <Mask size={24} />
                      Classic Bluff
                    </span>
                    <span>
                      <Icon name="users" />
                      {screen === "ai" ? botCount + 1 : maxPlayers} players
                    </span>
                    <span>
                      <Icon name="clock" />
                      {turnSeconds}s turns
                    </span>
                  </div>
                </div>
                <p className="muted fine">
                  {screen === "ai"
                    ? "Every AI plays from its own hand. No peeking."
                    : "Share your room code to invite friends."}
                </p>
              </section>
            )}
          </aside>
        </main>
      ) : state.phase === "finished" ? (
        <Results
          state={state}
          me={me}
          onRematch={() => emit("prepare_rematch")}
          onRequestRematch={() => emit("request_rematch")}
          onHome={leave}
        />
      ) : (
        <main className={`game-layout phase-${state.phase}`}>
          {gameSidebar}
          <section className="arena">
            <div className="arena-heading">
              <p className="overline">
                {state.mode === "ai" ? "AI PRACTICE TABLE" : state.roomName}
              </p>
              {state.phase === "lobby" && (
                <>
                  <h1>Pre-Game Lobby</h1>
                  <p>Take your seat, join voice, and ready up.</p>
                  <button
                    className="lobby-rules-link"
                    onClick={() => setModal("help")}
                  >
                    View table rules
                  </button>
                </>
              )}
            </div>
            <div
              className={`table seat-count-${players.length} ${players.length > 6 ? "large-table" : ""}`}
            >
              <div className="table-topline">
                <span>
                  Round <b>{state.roundNumber}</b>
                </span>
                <span className="rank-pill">
                  <Icon name="cards" size={18} />
                  {state.roundRank
                    ? `Current Rank: ${rankName(state.roundRank)} (${state.roundRank})`
                    : "Classic Bluff"}
                </span>
                <span>
                  <Icon name="clock" size={16} />
                  {storageUnavailable ? (
                    "Game storage is unavailable. Moves are paused until synchronization succeeds."
                  ) : syncing ? (
                    "Recovering your saved table..."
                  ) : !connected ? (
                    "Offline"
                  ) : state.pause ? (
                    <Deadline deadline={state.pause.until} prefix="Paused " />
                  ) : playing ? (
                    <Deadline deadline={state.turnEndsAt} />
                  ) : state.phase === "lobby" ? (
                    "Waiting"
                  ) : (
                    "Complete"
                  )}
                </span>
              </div>
              <div className="felt-mark">
                BLUFF<span>X</span>
                <small>TRUST NO ONE. PLAY EVERYONE.</small>
              </div>
              <div className="opponent-seats">
                {clockwiseSeats(players, me.id)
                  .slice(1)
                  .map((p, i) => (
                    <div
                      className={`seat clockwise-seat ${playing && p.id === state.currentTurnId ? "active" : ""}`}
                      style={opponentPosition(players.length, i)}
                      role="group"
                      aria-label={`Seat ${p.seatNumber}: ${p.name}`}
                      data-seat-number={p.seatNumber}
                      key={p.id}
                    >
                      <Avatar player={p} />
                      <div>
                        <strong>
                          <span className="seat-number">{p.seatNumber}</span>{" "}
                          {p.name}
                        </strong>
                        {!p.isBot && p.connected === false && (
                          <small className="presence-label">
                            {p.aiTakeover
                              ? `AI playing ? ${p.aiRoundsRemaining} rounds`
                              : "Offline ? reconnecting"}
                          </small>
                        )}
                        <small>
                          {state.phase === "lobby"
                            ? p.ready
                              ? "✓ Ready"
                              : "◷ Not ready"
                            : `${count(p)} cards`}
                        </small>
                        <div className="seat-bars">▰▰▰▰▰</div>
                      </div>
                      <div className="seat-cards">
                        <Back small />
                        <Back small />
                        <Back small />
                      </div>
                      {playing && p.id === state.currentTurnId && (
                        <label>TURN</label>
                      )}
                    </div>
                  ))}
              </div>
              <div className="table-center">
                {state.phase === "lobby" ? (
                  <>
                    <div className="lobby-deck">
                      <Back />
                    </div>
                    <div className="lobby-status">
                      <strong>
                        {players.length} / {state.maxPlayers} Players
                      </strong>
                      <small>
                        {state.mode === "ai"
                          ? `${players.length - 1} AI opponents are ready.`
                          : "Waiting for everyone to ready up."}
                      </small>
                    </div>
                  </>
                ) : state.phase === "provisional" ? (
                  <div className="round-result">
                    <div className="overline">AI-ASSISTED FINISH</div>
                    <h2>Waiting for the player to return</h2>
                    <p>
                      <Deadline
                        deadline={state.provisional.deadline}
                        suffix=""
                      />
                      s left. AI-assisted victories are unranked. If the player
                      does not return, their seat forfeits and the table
                      continues.
                    </p>
                  </div>
                ) : state.phase === "round_result" ? (
                  <RoundResult
                    result={state.lastResult}
                    host={host}
                    paused={
                      !!state.pause ||
                      !connected ||
                      storageUnavailable ||
                      syncing
                    }
                    deadline={state.resultDeadline}
                    onContinue={() => emit("continue_round")}
                  />
                ) : (
                  <>
                    <div className={`claim ${mine ? "your-move" : ""}`}>
                      <Mask size={44} />
                      <div>
                        <small>
                          {state.pendingWinnerId
                            ? `${players.find((p) => p.id === state.pendingWinnerId)?.name}'s final claim`
                            : claim
                              ? `${claim.playerName} claims:`
                              : mine
                                ? "The table is yours"
                                : "Waiting for a play"}
                        </small>
                        <strong>
                          {claim
                            ? `${claim.cardCount} ${rankName(claim.declaredRank)}`
                            : mine
                              ? "Your move."
                              : `${state.currentTurnName} is thinking…`}
                        </strong>
                      </div>
                    </div>
                    <div className="pile">
                      <Back />
                      <span>{state.pileCount} cards in the pile</span>
                    </div>
                    {state.pendingWinnerId && (
                      <p className="final-claim">
                        Final claim — pass or challenge to decide the winner.
                      </p>
                    )}
                  </>
                )}
              </div>
            </div>
            {state.phase === "lobby" ? (
              <>
                <div className="lobby-self">
                  <Avatar player={me} large />
                  <div>
                    <strong>
                      <span className="seat-number">{me.seatNumber}</span>{" "}
                      {me.name} {host && <Icon name="crown" size={18} />}
                    </strong>
                    <small className={me.ready ? "green" : "gold"}>
                      {me.ready ? "✓ Ready" : "◷ Not ready"}
                    </small>
                  </div>
                </div>
                <div className="lobby-info">
                  <span>
                    <Icon name="users" />
                    {players.length} Players
                  </span>
                  <span>
                    <Mask size={25} />
                    Classic Bluff
                  </span>
                  <span>
                    <Icon name="cards" />
                    {(state.deckCount || 1) * 52}-card deck
                  </span>
                </div>
                <div className="lobby-actions">
                  {host && (
                    <button
                      className="secondary"
                      onClick={() => setModal("table-settings")}
                    >
                      Table settings
                    </button>
                  )}
                  <button className="secondary" onClick={copyInvite}>
                    <Icon name="copy" />
                    Copy Invitation Link
                  </button>
                  <button
                    className="secondary"
                    onClick={() => emit("set_ready", { ready: !me.ready })}
                  >
                    {me.ready ? "Not Ready" : "Ready Up"} (
                    {players.filter((p) => p.ready).length}/{players.length})
                  </button>
                  {host ? (
                    <button
                      className="primary"
                      disabled={
                        players.length < 2 || players.some((p) => !p.ready)
                      }
                      onClick={() => emit("start_game")}
                    >
                      <Icon name="play" />
                      Start Match
                    </button>
                  ) : null}
                </div>
              </>
            ) : playing ? (
              <>
                <div className="hand-area">
                  <div className={`your-seat ${mine ? "active" : ""}`}>
                    <Avatar player={me} />
                    <div>
                      <strong>
                        <span className="seat-number">{me.seatNumber}</span> You
                        ({me.name})
                      </strong>
                      <small>
                        {state.hand.length} cards {mine ? "· Your turn" : ""}
                      </small>
                    </div>
                  </div>
                  <HandFan
                    cards={state.hand}
                    selected={selected}
                    expanded={handExpanded}
                    onToggle={(id) =>
                      setSelected((current) =>
                        current.includes(id)
                          ? current.filter((cardId) => cardId !== id)
                          : current.length < (state.rules?.maxCards || 4)
                            ? [...current, id]
                            : current,
                      )
                    }
                  />
                  <div className="hand-caption">
                    <span>
                      {state.hand.length === 0
                        ? "FINAL CLAIM · Waiting for the table to pass or challenge"
                        : selected.length
                          ? `${selected.length} selected · Click a card again to deselect`
                          : "YOUR HAND · Select cards to play face down"}
                    </span>
                    {state.hand.length > 0 && (
                      <button
                        className="hand-toggle"
                        aria-pressed={handExpanded}
                        onClick={() => setHandExpanded((value) => !value)}
                      >
                        {handExpanded ? "Fan view" : "Show all cards"}
                      </button>
                    )}
                  </div>
                </div>
                {!state.pendingWinnerId && (mine || state.roundRank) && (
                  <RankPicker
                    value={state.roundRank || rank}
                    onChange={setRank}
                    count={selected.length}
                    locked={Boolean(state.roundRank)}
                  />
                )}
                <div className="actions">
                  <button
                    className="play-action"
                    disabled={
                      !mine || !!state.pendingWinnerId || !selected.length
                    }
                    onClick={() => {
                      emit("play_cards", {
                        cardIds: selected,
                        declaredRank: state.roundRank || rank,
                      });
                      setSelected([]);
                    }}
                  >
                    <Icon name="cards" size={34} />
                    <div>
                      <strong>Play Face Down</strong>
                      <small>
                        {selected.length
                          ? `Claim ${selected.length} ${rankName(state.roundRank || rank, selected.length)}`
                          : "Select your cards first"}
                      </small>
                    </div>
                  </button>
                  <button
                    className="bluff-action"
                    disabled={
                      storageUnavailable ||
                      syncing ||
                      me.aiTakeover ||
                      !connected ||
                      !!state.pause ||
                      !claim ||
                      claim.playerId === me.id ||
                      claim.passedBy.includes(me.id)
                    }
                    onClick={() => setModal("challenge")}
                  >
                    <Icon name="alert" size={34} />
                    <div>
                      <strong>Call Bluff</strong>
                      <small>Challenge the claim!</small>
                    </div>
                  </button>
                  <button
                    className="pass-action"
                    disabled={!mine || !claim || claim.playerId === me.id}
                    onClick={() => emit("pass_bluff")}
                  >
                    <Icon name="skip" size={28} />
                    <div>
                      <strong>Pass</strong>
                      <small>Accept the claim</small>
                    </div>
                  </button>
                </div>
              </>
            ) : null}
          </section>
          <aside className="right">
            {state.phase !== "lobby" && (
              <section className="panel history-panel">
                <h3>
                  <Icon name="clock" />
                  Turn History
                  <span className="live-dot" />
                </h3>
                <div className="history-scroll">
                  {history.length ? (
                    history.map((entry, i) => (
                      <div className="history-entry" key={entry.id}>
                        <small>
                          {i === 0
                            ? "Latest at the table"
                            : "Earlier at the table"}
                        </small>
                        <p>
                          <i className={entry.tone}>
                            {entry.tone === "purple" ? "▶" : "✓"}
                          </i>
                          {entry.text}
                        </p>
                      </div>
                    ))
                  ) : (
                    <div className="empty-feed">
                      Your first move starts the story.
                    </div>
                  )}
                </div>
              </section>
            )}
            {chat}
          </aside>
        </main>
      )}
      <footer>
        <div className="footer-tools">
          <button onClick={() => setModal("report")}>Report a problem</button>
          <button onClick={() => setModal("privacy")}>Privacy</button>
          <button onClick={() => setModal("preferences")}>Preferences</button>
          {account && (
            <button onClick={() => setModal("community")}>
              Friends & Records
            </button>
          )}
          <small>Build {BUILD}</small>
        </div>
        <span>♧ BLUFFX SOCIAL CLUB</span>
        <span>Good cards help. A good bluff wins.</span>
        <span className={connected ? "green" : "gold"}>
          ●{" "}
          {connected
            ? slowConnection
              ? "Slow action responses"
              : "Connected"
            : "Connecting to server"}
        </span>
      </footer>
      {error && (
        <div className="toast" role="status" onClick={() => setError("")}>
          {error}
        </div>
      )}
      {modal && (
        <div
          className="modal-backdrop"
          onClick={() => {
            if (!["tutorial", "tutorial-offer"].includes(modal)) closeModal();
          }}
        >
          <section
            className={`panel modal ${modal === "profile" ? "profile-modal" : ""} ${modal === "tutorial" ? "tutorial-modal" : ""}`}
            role="dialog"
            aria-modal="true"
            aria-label={
              modal === "tutorial-offer"
                ? "Welcome to BluffX"
                : modal === "tutorial"
                  ? "Tutorial game"
                  : modal
            }
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="close"
              aria-label="Close dialog"
              onClick={closeModal}
              disabled={tutorialBusy}
            >
              <Icon name="close" />
            </button>
            {modal === "table-settings" ? (
              <section>
                <h2>Table settings</h2>
                <p>Changing settings asks everyone to ready up again.</p>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const d = new FormData(e.currentTarget);
                    emit("update_settings", {
                      maxPlayers: Number(d.get("capacity")),
                      deckCount: Number(d.get("decks")),
                      turnSeconds: Number(d.get("seconds")),
                      preset: "custom",
                      voiceEnabled: state.voiceEnabled !== false,
                      aiStyle: state.aiStyle || "balanced",
                    });
                    setModal(null);
                  }}
                >
                  <Field label="Capacity">
                    <select name="capacity" defaultValue={state.maxPlayers}>
                      {Array.from({ length: 9 }, (_, i) => i + 2)
                        .filter((n) => n >= players.length)
                        .map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                    </select>
                  </Field>
                  <Field label="Decks">
                    <select name="decks" defaultValue={state.deckCount || 1}>
                      <option value="1">One (52 cards)</option>
                      <option value="2">Two (104 cards)</option>
                    </select>
                  </Field>
                  <Field label="Seconds per turn">
                    <select name="seconds" defaultValue={state.turnSeconds}>
                      {[20, 30, 45, 60].map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <button className="primary">Save table settings</button>
                </form>
              </section>
            ) : modal === "community" ? (
              <Community
                revision={socialRevision}
                roomId={state?.roomId}
                onInvite={(room) => {
                  if (state) {
                    setError(
                      "Leave your current table before joining another.",
                    );
                    return;
                  }
                  setCode(room);
                  setScreen("join");
                  setModal(null);
                }}
              />
            ) : modal === "preferences" ? (
              <Preferences />
            ) : modal === "report" ? (
              <ReportProblem />
            ) : modal === "privacy" ? (
              <PrivacyInfo />
            ) : modal === "kick" ? (
              <>
                <h2>Remove this player?</h2>
                <p>
                  They leave immediately and forfeit an active match. Their
                  account cannot rejoin this table.
                </p>
                <button
                  className="primary"
                  onClick={() => {
                    emit("kick_player", { playerId: kickTarget });
                    setModal(null);
                  }}
                >
                  Remove player
                </button>
              </>
            ) : modal === "tutorial-offer" ? (
              <div className="tutorial-welcome">
                <span className="tutorial-welcome-icon">
                  <Mask size={58} />
                </span>
                <div className="overline">WELCOME TO THE CLUB</div>
                <h2>Want a practice game, {profile.name || "Player"}?</h2>
                <p>
                  Learn by playing a short guided hand. Make a claim, catch a
                  bluff, and find out how to win.
                </p>
                <div className="tutorial-welcome-facts">
                  <span>
                    <Icon name="clock" size={17} />
                    About 3 minutes
                  </span>
                  <span>
                    <Icon name="cards" size={17} />
                    No match stats
                  </span>
                </div>
                <button
                  className="primary wide"
                  disabled={tutorialBusy}
                  onClick={() => setModal("tutorial")}
                >
                  <Icon name="play" />
                  Start Tutorial Game
                </button>
                <button
                  className="tutorial-skip"
                  disabled={tutorialBusy}
                  onClick={() => saveTutorial("skipped")}
                >
                  {tutorialBusy ? "Saving?" : "Skip for now"}
                </button>
                <small>You can replay it any time from How to Play.</small>
              </div>
            ) : modal === "tutorial" ? (
              <TutorialGame
                player={me}
                busy={tutorialBusy}
                onComplete={() => saveTutorial("completed")}
              />
            ) : modal === "profile" ? (
              profileContent
            ) : modal === "leave" ? (
              <>
                <h2>Leave this table?</h2>
                <p>Your seat will be removed from this match.</p>
                <button className="primary wide" onClick={leave}>
                  Leave Table
                </button>
                <button
                  className="secondary wide"
                  onClick={() => setModal(null)}
                >
                  Stay at the table
                </button>
              </>
            ) : modal === "challenge" ? (
              <Challenge
                key={claim?.ts}
                claim={claim}
                onConfirm={(indexes) => {
                  emit("call_bluff", {
                    selectedIndexes: indexes,
                    claimTs: claim.ts,
                  });
                  setModal(null);
                }}
              />
            ) : modal === "scores" ? (
              <>
                <div className="overline">VERIFIED PLAYER RECORDS</div>
                <h2>Leaderboard</h2>
                {leaders.players.map((p) => (
                  <div className="score-row" key={p.id}>
                    <Avatar player={p} />
                    <span>
                      {p.rank}. {p.name}
                      <small>
                        {p.games} games - {p.losses} losses - {p.winRate}% win
                        rate
                      </small>
                    </span>
                    <strong>{p.wins} wins</strong>
                  </div>
                ))}
                {!leaders.players.length && (
                  <p>
                    No verified competitive results yet. Practice and legacy
                    browser results are unranked.
                  </p>
                )}
                <div className="leaderboard-pages">
                  <button
                    disabled={!leaders.page}
                    onClick={() =>
                      setLeaders((l) => ({ ...l, page: l.page - 1 }))
                    }
                  >
                    Previous
                  </button>
                  <span>Page {leaders.page + 1}</span>
                  <button
                    disabled={
                      (leaders.page + 1) * leaders.limit >= leaders.total
                    }
                    onClick={() =>
                      setLeaders((l) => ({ ...l, page: l.page + 1 }))
                    }
                  >
                    Next
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="overline">THE ART OF DECEPTION</div>
                <h2>How to Play</h2>
                <div className="tutorial-launch">
                  <div>
                    <Icon name="play" size={26} />
                    <span>
                      <strong>Learn with a practice game</strong>
                      <small>
                        A guided hand, from your first claim to your first win.
                      </small>
                    </span>
                  </div>
                  <button
                    className="primary wide"
                    disabled={Boolean(state && state.phase !== "finished")}
                    onClick={() => setModal("tutorial")}
                  >
                    Play Tutorial Game
                    <Icon name="arrow" size={18} />
                  </button>
                  {state && state.phase !== "finished" && (
                    <p>Leave or finish this table to start the tutorial.</p>
                  )}
                </div>
                <ol>
                  <li>
                    <b>Empty your hand.</b> All 52 cards are dealt between the
                    players.
                  </li>
                  <li>
                    <b>Play face down.</b> Select one to four cards and choose a
                    rank for a new pile. Every subsequent claim uses that same
                    rank.
                  </li>
                  <li>
                    <b>Play, pass, or challenge.</b> On your turn you may add a
                    claim or pass. Any opponent who has not passed can call
                    bluff.
                  </li>
                  <li>
                    <b>Pick your evidence.</b> Reveal half the latest claim,
                    rounded down (at least one). Any false card means the
                    claimant takes the entire pile. Otherwise, the caller takes
                    it.
                  </li>
                  <li>
                    <b>Finish strong.</b> Once you play your last card,
                    opponents must pass or challenge. If everyone passes, or
                    your claim survives a challenge, you win. If caught, pick up
                    the pile and keep playing.
                  </li>
                </ol>
                <p>
                  Round results advance automatically after 10 seconds; the host
                  can advance earlier. A turn timeout counts as a pass when
                  there is a claim. Miss one turn: Possibly AFK. Miss two: final
                  warning. Miss three: temporary AI takes over without extra
                  grace. Use “I’m Back — Take Control” to resume; your current
                  hand and running timer stay intact. Only a valid human play,
                  pass or challenge clears strikes. Chat and reconnects do not.
                </p>
                <p>
                  Table Voice is optional. Select Join Voice to listen, then
                  Unmute Mic to allow microphone access and speak. Muting
                  releases your microphone while keeping you connected. Deafen
                  silences other players without muting your mic; each player
                  has a volume slider. Leaving voice or losing your connection
                  stops the microphone. Voice activity does not clear AFK
                  warnings. Audio connects directly between players and is not
                  recorded by BluffX.
                </p>
                <p>
                  Each seat has a cumulative 10-second reconnect budget per
                  round, then up to three rounds of temporary AI. Brief returns
                  do not reset that allowance. Renewal requires 60 seconds
                  continuously online and a valid turn action. An absent AI
                  winner has 10 seconds to return for an unranked AI-assisted
                  result; otherwise that seat forfeits. Only matches with at
                  least two verified accounts, no practice bots, and a human
                  winner without AI assistance affect competitive wins. Guest
                  and practice results are unranked. Casual playtest tables do
                  not affect rankings. A pair of accounts can contribute at most{" "}
                  {authConfig?.rankedPairDailyLimit || 3} ranked results per UTC
                  day; additional matches remain casual.
                </p>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
