import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { Icon, Mask, Fan } from "./components";
import { BetaVersion } from "./DisplayHints";
import { socket, clearSeatResume, hasGuestSeat } from "./lib/socket";
import { ConfirmDeletion } from "./LaunchTools";
const BASE = import.meta.env.VITE_SERVER_URL || "http://localhost:4000";
const AuthContext = createContext(null);
export const useAuth = () => useContext(AuthContext);
export async function authRequest(path, body, method = "POST", signal) {
  const response = await fetch(`${BASE}/auth/${path}`, {
    method,
    credentials: "include",
    signal:
      signal || (AbortSignal.timeout ? AbortSignal.timeout(30000) : undefined),
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response
    .json()
    .catch(() => ({ message: "The server returned an unexpected response." }));
  if (!response.ok)
    throw Error(data.message || "Unable to complete this request.");
  return data;
}
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null),
    [loading, setLoading] = useState(true),
    [guest, setGuest] = useState(
      () => sessionStorage.getItem("bluffx:guest") === "true" || hasGuestSeat(),
    ),
    [config, setConfig] = useState(null),
    [error, setError] = useState("");
  const [flow, setFlow] = useState(() => {
    const q = new URLSearchParams(location.search);
    return ["reset", "verify", "delete"].includes(q.get("auth"))
      ? { mode: q.get("auth"), token: q.get("token") || "" }
      : null;
  });
  const refresh = async () => {
    const result = await authRequest("session", undefined, "GET");
    setUser(result.user);
    return result.user;
  };
  useEffect(() => {
    let active = true,
      timer,
      wake;
    const controller = new AbortController();
    (async () => {
      for (let attempt = 0; attempt < 6 && active; attempt++) {
        try {
          const signal = AbortSignal.any
            ? AbortSignal.any([controller.signal, AbortSignal.timeout(30000)])
            : controller.signal;
          const [session, configuration] = await Promise.all([
            authRequest("session", undefined, "GET", signal),
            authRequest("config", undefined, "GET", signal),
          ]);
          if (active) {
            setUser(session.user);
            setConfig(configuration);
            setError("");
            setLoading(false);
          }
          return;
        } catch {
          if (!active) return;
          setError(
            "Connecting to BluffX server... The server may be waking up.",
          );
          if (attempt < 5)
            await new Promise((resolve) => {
              wake = resolve;
              timer = setTimeout(resolve, Math.min(15000, 1000 * 2 ** attempt));
            });
        }
      }
      if (active) setLoading(false);
    })();
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timer);
      wake?.();
    };
  }, []);
  useEffect(() => {
    if (!loading && (user || guest) && !flow) socket.connect();
    else socket.disconnect();
    return () => socket.disconnect();
  }, [loading, user?.id, guest, flow]);
  useEffect(() => {
    const revoked = () => {
      clearSeatResume();
      setUser(null);
      setGuest(false);
      sessionStorage.removeItem("bluffx:guest");
      socket.disconnect();
    };
    socket.on("account_revoked", revoked);
    return () => socket.off("account_revoked", revoked);
  }, []);
  const clearLink = () => {
    history.replaceState({}, "", location.pathname);
    setFlow(null);
  };
  const authenticated = (account) => {
    sessionStorage.removeItem("bluffx:guest");
    setGuest(false);
    setUser(account);
    clearLink();
  };
  const continueGuest = () => {
    sessionStorage.setItem("bluffx:guest", "true");
    setGuest(true);
    clearLink();
  };
  const openLogin = () => {
    sessionStorage.removeItem("bluffx:guest");
    setGuest(false);
    socket.disconnect();
  };
  const logout = async () => {
    await authRequest("logout", {});
    clearSeatResume();
    setUser(null);
    setGuest(false);
    sessionStorage.removeItem("bluffx:guest");
    socket.disconnect();
  };
  if (loading)
    return (
      <div className="auth-loading">
        <Mask size={60} />
        <strong>Connecting to BluffX server...</strong>
        <p>Checking your connection and restoring your saved seat.</p>
      </div>
    );
  if (flow?.mode === "delete")
    return (
      <ConfirmDeletion
        token={flow.token}
        onDone={(deleted) => {
          if (deleted) {
            clearSeatResume();
            setUser(null);
            setGuest(false);
            sessionStorage.removeItem("bluffx:guest");
          }
          clearLink();
        }}
      />
    );
  if (flow || (!user && !guest))
    return (
      <AuthPage
        key={flow ? `${flow.mode}:${flow.token}` : "login"}
        config={config}
        initialMode={flow?.mode || "login"}
        token={flow?.token}
        serverError={error}
        onAuthenticated={authenticated}
        onGuest={continueGuest}
        onClearFlow={() => {
          setUser(null);
          clearLink();
        }}
      />
    );
  return (
    <AuthContext.Provider
      value={{ user, setUser, config, refresh, logout, openLogin }}
    >
      <React.Fragment key={user?.id || "guest"}>{children}</React.Fragment>
    </AuthContext.Provider>
  );
}
let googleScript;
function loadGoogle() {
  if (window.google?.accounts?.id) return Promise.resolve();
  if (googleScript) return googleScript;
  googleScript = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.onload = resolve;
    script.onerror = () => {
      googleScript = null;
      script.remove();
      reject(Error("Google sign-in could not load. Check your connection."));
    };
    document.head.appendChild(script);
  });
  return googleScript;
}
function GoogleMark() {
  return (
    <svg width="21" height="21" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#4285f4"
        d="M43.6 24.5c0-1.4-.1-2.8-.4-4.2H24v8h11a9.5 9.5 0 0 1-4.1 6.2v5.2h6.7c3.9-3.6 6-8.9 6-15.2Z"
      />
      <path
        fill="#34a853"
        d="M24 44c5.5 0 10.1-1.8 13.5-4.9l-6.7-5.2c-1.8 1.2-4.1 1.9-6.8 1.9-5.3 0-9.8-3.6-11.4-8.4H5.7v5.4A20.4 20.4 0 0 0 24 44Z"
      />
      <path
        fill="#fbbc05"
        d="M12.6 27.4a12 12 0 0 1 0-7V15H5.7a20 20 0 0 0 0 17.8l6.9-5.4Z"
      />
      <path
        fill="#ea4335"
        d="M24 12.2c3 0 5.7 1 7.8 3l5.9-5.9A19.7 19.7 0 0 0 24 4 20.4 20.4 0 0 0 5.7 15l6.9 5.4C14.2 15.7 18.7 12.2 24 12.2Z"
      />
    </svg>
  );
}
function AuthPage({
  config,
  initialMode,
  token,
  serverError,
  onAuthenticated,
  onGuest,
  onClearFlow,
}) {
  const [mode, setMode] = useState(initialMode),
    [name, setName] = useState(""),
    [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [confirm, setConfirm] = useState(""),
    [showPassword, setShowPassword] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [done, setDone] = useState(false);
  const googleRoot = useRef(null),
    googleVisible = mode === "login" || mode === "signup";
  const switchMode = (next) => {
    setMode(next);
    setError("");
    setNotice("");
    setDone(false);
    setPassword("");
    setConfirm("");
  };
  useEffect(() => {
    if (!config?.googleClientId || !googleVisible) return;
    let active = true;
    let resizeObserver;
    loadGoogle()
      .then(() => {
        if (!active || !googleRoot.current) return;
        window.google.accounts.id.initialize({
          client_id: config.googleClientId,
          callback: async (result) => {
            if (!active) return;
            setBusy(true);
            setError("");
            try {
              const data = await authRequest("google", {
                credential: result.credential,
              });
              onAuthenticated(data.user);
            } catch (e) {
              if (active) setError(e.message);
            } finally {
              if (active) setBusy(false);
            }
          },
        });
        const container = googleRoot.current;
        let lastWidth = 0;
        const render = () => {
          const width = Math.min(400, Math.floor(container.clientWidth));
          if (!active || width < 1 || width === lastWidth) return;
          lastWidth = width;
          container.replaceChildren();
          window.google.accounts.id.renderButton(container, {
            theme: "filled_black",
            size: "large",
            shape: "rectangular",
            text: "continue_with",
            logo_alignment: "left",
            width,
          });
        };
        render();
        resizeObserver = new ResizeObserver(render);
        resizeObserver.observe(container);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
      resizeObserver?.disconnect();
    };
  }, [config?.googleClientId, googleVisible]);
  const submit = async (e) => {
    e.preventDefault();
    setError("");
    setNotice("");
    if ((mode === "signup" || mode === "reset") && password !== confirm)
      return setError("Your passwords do not match.");
    setBusy(true);
    try {
      if (mode === "login" || mode === "signup") {
        const data = await authRequest(mode, { email, password, name });
        onAuthenticated(data.user);
      } else if (mode === "forgot") {
        const data = await authRequest("forgot-password", { email });
        setNotice(data.message);
        setDone(true);
      } else if (mode === "reset") {
        const data = await authRequest("reset-password", { token, password });
        setNotice(data.message);
        setDone(true);
      } else if (mode === "verify") {
        const data = await authRequest("verify-email", { token });
        setNotice(data.message);
        setDone(true);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const heading = {
    login: "Welcome back.",
    signup: "Join the table.",
    forgot: "Back in the game.",
    reset: "A fresh start.",
    verify: "Make it official.",
  }[mode];
  const subtitle = {
    login: "Your next great bluff is one sign-in away.",
    signup: "Create your account. Keep them guessing.",
    forgot: "We’ll send you a link to reset your password.",
    reset: "Choose a new password for your BluffX account.",
    verify: "Verify your email to complete your account.",
  }[mode];
  return (
    <div className="auth-page">
      <header className="auth-header">
        <div className="brand">
          <img
            className="brand-icon"
            src="/bluffx.ico"
            alt=""
            width="42"
            height="42"
          />
          Bluff<span>X</span>
          <BetaVersion />
        </div>
        <span className="auth-header-note">
          <Icon name="lock" size={14} />
          YOUR SEAT IS WAITING
        </span>
      </header>
      <main className="auth-layout">
        <section className="auth-story">
          <div className="overline">THE BLUFFX SOCIAL CLUB</div>
          <h1>
            A little truth.
            <br />A better <em>bluff.</em>
          </h1>
          <p>
            Read the room. Make your move.
            <br />
            Give them something to believe.
          </p>
          <Fan />
          <div className="auth-perks">
            <span>
              <Icon name="users" size={19} />
              Play with friends
            </span>
            <span>
              <Icon name="bolt" size={19} />
              Sharpen your game
            </span>
            <span>
              <Mask size={21} />
              Own your identity
            </span>
          </div>
        </section>
        <section className="panel auth-card">
          <div className="auth-card-top">
            <span className="auth-emblem">
              <Mask size={31} />
            </span>
            <span className="overline">
              {mode === "signup" ? "BECOME A BLUFFER" : "GOOD TO HAVE YOU HERE"}
            </span>
          </div>
          <h2>{heading}</h2>
          <p className="auth-subtitle">{subtitle}</p>
          {googleVisible && (
            <>
              <div className="auth-tabs" aria-label="Account action">
                <button
                  type="button"
                  className={mode === "login" ? "active" : ""}
                  onClick={() => switchMode("login")}
                  disabled={busy}
                >
                  Sign In
                </button>
                <button
                  type="button"
                  className={mode === "signup" ? "active" : ""}
                  onClick={() => switchMode("signup")}
                  disabled={busy}
                >
                  Create Account
                </button>
              </div>
              {config?.googleClientId ? (
                <div
                  className={`google-widget ${busy ? "busy" : ""}`}
                  ref={googleRoot}
                />
              ) : (
                <>
                  <button
                    type="button"
                    className="google-button"
                    disabled
                    aria-label="Continue with Google — setup required"
                  >
                    <GoogleMark />
                    Continue with Google
                  </button>
                  <p className="provider-note">
                    Google sign-in is coming once the host finishes setup.
                  </p>
                </>
              )}
              <div className="auth-divider">
                <span />
                or continue with email
                <span />
              </div>
            </>
          )}
          {(error || serverError) && (
            <div className="auth-message error" role="alert">
              <Icon name="alert" size={18} />
              <span>{error || serverError}</span>
            </div>
          )}
          {notice && (
            <div className="auth-message success" role="status">
              <Icon name="check" size={18} />
              <span>{notice}</span>
            </div>
          )}
          <form onSubmit={submit}>
            {!done && (
              <>
                {mode === "signup" && (
                  <label className="auth-field">
                    Player name
                    <div>
                      <Icon name="user" size={18} />
                      <input
                        required
                        autoComplete="nickname"
                        value={name}
                        maxLength={20}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="Your name at the table"
                        disabled={busy}
                      />
                    </div>
                  </label>
                )}
                {["login", "signup", "forgot"].includes(mode) && (
                  <label className="auth-field">
                    Email address
                    <div>
                      <span className="email-symbol" aria-hidden="true">
                        @
                      </span>
                      <input
                        required
                        type="email"
                        aria-label="Email address"
                        autoComplete="email"
                        value={email}
                        maxLength={254}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="you@example.com"
                        disabled={busy}
                      />
                    </div>
                  </label>
                )}
                {["login", "signup", "reset"].includes(mode) && (
                  <>
                    <label className="auth-field">
                      Password
                      <div>
                        <Icon name="lock" size={18} />
                        <input
                          required
                          type={showPassword ? "text" : "password"}
                          autoComplete={
                            mode === "login"
                              ? "current-password"
                              : "new-password"
                          }
                          minLength={8}
                          maxLength={128}
                          value={password}
                          aria-label="Password"
                          onChange={(e) => setPassword(e.target.value)}
                          placeholder={
                            mode === "login"
                              ? "Enter your password"
                              : "At least 8 characters"
                          }
                          disabled={busy}
                        />
                        <button
                          type="button"
                          aria-label={
                            showPassword ? "Hide password" : "Show password"
                          }
                          onClick={() => setShowPassword((v) => !v)}
                        >
                          <Icon name="eye" size={18} />
                        </button>
                      </div>
                    </label>
                    {mode === "login" && (
                      <button
                        type="button"
                        className="auth-forgot"
                        onClick={() => switchMode("forgot")}
                        disabled={busy}
                      >
                        Forgot password?
                      </button>
                    )}
                    {(mode === "signup" || mode === "reset") && (
                      <label className="auth-field">
                        Confirm password
                        <div>
                          <Icon name="lock" size={18} />
                          <input
                            required
                            type={showPassword ? "text" : "password"}
                            autoComplete="new-password"
                            minLength={8}
                            maxLength={128}
                            value={confirm}
                            onChange={(e) => setConfirm(e.target.value)}
                            placeholder="Enter your password again"
                            disabled={busy}
                          />
                        </div>
                      </label>
                    )}
                  </>
                )}
                {mode === "verify" && (
                  <div className="verify-illustration">
                    <Icon name="check" size={54} />
                  </div>
                )}
                <button
                  className="primary wide auth-submit"
                  disabled={busy || !!serverError}
                >
                  {busy
                    ? "Just a moment…"
                    : {
                        login: "Sign In",
                        signup: "Create Account",
                        forgot: "Send Reset Link",
                        reset: "Save New Password",
                        verify: "Verify My Email",
                      }[mode]}
                  <Icon name="arrow" size={19} />
                </button>
              </>
            )}
          </form>
          {done && mode === "forgot" && (
            <p className="auth-subtitle">
              Check your inbox. The link is valid for 30 minutes.
            </p>
          )}
          {config?.emailDelivery === "local" &&
            ["signup", "forgot", "verify"].includes(mode) && (
              <p className="provider-note local-mail">
                Local setup: email previews are saved on the server until email
                delivery is connected.
              </p>
            )}
          {googleVisible ? (
            <p className="auth-switch">
              {mode === "login" ? "New to BluffX?" : "Already at the table?"}
              <button
                type="button"
                onClick={() =>
                  switchMode(mode === "login" ? "signup" : "login")
                }
                disabled={busy}
              >
                {mode === "login" ? "Create an account" : "Sign in"}
              </button>
            </p>
          ) : (
            <button
              className="auth-back"
              type="button"
              onClick={() => {
                if (initialMode === "reset" || initialMode === "verify")
                  onClearFlow();
                else switchMode("login");
              }}
              disabled={busy}
            >
              <Icon name="back" size={16} />
              Back to sign in
            </button>
          )}
          {googleVisible && (
            <button
              className="guest-button"
              type="button"
              onClick={onGuest}
              disabled={busy}
            >
              Just looking? Continue as guest
              <Icon name="arrow" size={15} />
            </button>
          )}
          <div className="auth-card-footer">
            <Icon name="lock" size={12} />
            <span>Your cards are secret. Your account stays yours.</span>
          </div>
        </section>
      </main>
      <footer>
        <span>♧ BLUFFX SOCIAL CLUB</span>
        <span>Good cards help. A good bluff wins.</span>
      </footer>
    </div>
  );
}
