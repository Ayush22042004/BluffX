import React, { useEffect, useRef, useState } from "react";
export const RANKS = [
  "A",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "J",
  "Q",
  "K",
];
const SUITS = { S: "♠", H: "♥", D: "♦", C: "♣" };
export const rankName = (r, count) => {
  const label =
    { A: "Aces", J: "Jacks", Q: "Queens", K: "Kings" }[r] || `${r}s`;
  return count === 1 ? label.slice(0, -1) : label;
};
export function Icon({ name = "cards", size = 24, ...props }) {
  const paths = {
    home: "m3 11 9-8 9 8M5 10v11h5v-7h4v7h5V10",
    users:
      "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 3a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-3.87M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
    user: "M20 21v-2a7 7 0 0 0-14 0v2M17 7a5 5 0 1 1-10 0 5 5 0 0 1 10 0",
    trophy:
      "M8 3h8v6a4 4 0 0 1-8 0V3ZM8 5H4v3a4 4 0 0 0 4 4M16 5h4v3a4 4 0 0 1-4 4M12 13v6M8 21h8M10 19h4",
    arrow: "M5 12h14m-6-6 6 6-6 6",
    join: "M14 3h6v18h-6M3 12h12m-5-5 5 5-5 5",
    bolt: "m13 2-9 12h7l-1 8 10-12h-8l1-8Z",
    lock: "M5 10h14v11H5V10ZM8 10V6a4 4 0 0 1 8 0v4M12 14v3",
    chat: "M21 3H3v14h4v5l6-5h8V3Z",
    clock: "M12 7v5l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
    book: "M12 5C8 2 5 3 2 4v16c4-2 7-1 10 1 3-2 6-3 10-1V4c-3-1-6-2-10 1Zm0 0v16",
    copy: "M9 8h12v14H9V8ZM15 8V2H3v14h6",
    check: "m5 12 4 4L20 5",
    close: "m6 6 12 12M6 18 18 6",
    send: "m22 2-7 20-4-9-9-4L22 2Zm0 0L11 13",
    crown: "m3 6 5 4 4-7 4 7 5-4-2 13H5L3 6ZM6 22h12",
    flag: "M4 22V3c5-4 10 4 16 0v12c-6 4-11-4-16 0",
    back: "M20 12H4m6-6-6 6 6 6",
    refresh: "M20 7a9 9 0 1 0 1 9M20 2v6h-6",
    eye: "M2 12s4-8 10-8 10 8 10 8-4 8-10 8S2 12 2 12ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
    cards: "m7 2 14 4-5 17L2 19 7 2ZM9 7l7 2-2 8-7-2 2-8Z",
    alert: "m12 2 11 20H1L12 2Zm0 7v5m0 3v1",
    play: "m7 3 14 9-14 9V3Z",
    skip: "m2 4 9 8-9 8V4Zm11 0 9 8-9 8V4Z",
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d={paths[name] || paths.cards} />
    </svg>
  );
}
export function Mask({ size = 32 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <path
        d="M5 10 24 16 43 10C44 31 35 40 24 42 13 40 4 31 5 10Z"
        fill="currentColor"
      />
      <path
        d="m11 21 10 4c-2 7-10 3-10-4Zm26 0-10 4c2 7 10 3 10-4ZM18 34q6-5 12 0"
        fill="#230d25"
      />
    </svg>
  );
}
export function Avatar({ player, large = false, onClick }) {
  return (
    <span
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={(e) => onClick && e.key === "Enter" && onClick()}
      aria-label={onClick ? "Open my profile" : undefined}
      className={`avatar portrait-${player?.avatar || 0} ${large ? "large" : ""}`}
    >
      <i />
    </span>
  );
}
export function Back({ small = false }) {
  return (
    <span className={`card-back ${small ? "small" : ""}`}>
      <Mask size={small ? 19 : 40} />
    </span>
  );
}
export function Card({ card, selected, onClick, style }) {
  return (
    <button
      type="button"
      aria-label={`${card.rank} ${SUITS[card.suit]}`}
      aria-pressed={Boolean(selected)}
      onClick={onClick}
      style={style}
      className={`card ${"HD".includes(card.suit) ? "red" : ""} ${selected ? "selected" : ""}`}
    >
      <b>
        {card.rank}
        <small>{SUITS[card.suit]}</small>
      </b>
      <span>
        {["J", "Q", "K"].includes(card.rank)
          ? { J: "♜", Q: "♛", K: "♚" }[card.rank]
          : SUITS[card.suit]}
      </span>
      <b className="bottom">
        {card.rank}
        <small>{SUITS[card.suit]}</small>
      </b>
    </button>
  );
}
export function Fan({ className = "" }) {
  return (
    <div className={`decor-fan ${className}`} aria-hidden="true">
      {[-32, -16, 0, 16, 32].map((angle, i) => (
        <div
          style={{
            transform: `rotate(${angle}deg) translateY(${Math.abs(angle)}px)`,
            zIndex: 3 - Math.abs(i - 2),
          }}
          key={i}
        >
          <Back />
        </div>
      ))}
    </div>
  );
}
export function Field({ label, children }) {
  return (
    <div className="field">
      <span>{label}</span>
      {React.Children.map(children, (child) =>
        React.isValidElement(child) &&
        ["input", "select", "textarea"].includes(child.type)
          ? React.cloneElement(child, {
              "aria-label": child.props["aria-label"] || label,
            })
          : child,
      )}
    </div>
  );
}
export function Segments({ values, value, onChange, label }) {
  return (
    <div className="segments" aria-label={label}>
      {values.map((v) => (
        <button
          type="button"
          key={v}
          aria-pressed={value === v}
          className={value === v ? "selected" : ""}
          onClick={() => onChange(v)}
        >
          {v}
        </button>
      ))}
    </div>
  );
}
export function Stat({ label, value, icon }) {
  return (
    <div className="stat">
      <span>
        <Icon name={icon} size={18} />
        {label}
      </span>
      <strong>{value}</strong>
    </div>
  );
}
export function Action({ icon, title, description, onClick, tone = "pink" }) {
  return (
    <button className={`action-tile ${tone}`} onClick={onClick}>
      <Icon name={icon} size={55} />
      <h2>{title}</h2>
      <p>{description}</p>
      <span className="tile-arrow">
        <Icon name="arrow" />
      </span>
    </button>
  );
}
export function Chat({ messages, chatRef, enabled, onSend, title }) {
  const [text, setText] = useState("");
  return (
    <section className="panel chat-panel">
      <h3>
        <Icon name="chat" />
        {title}
        <Icon name="users" size={20} />
      </h3>
      <div className="chat-scroll" ref={chatRef}>
        {messages.length ? (
          messages.map((m) => (
            <div className="chat-message" key={m.id}>
              <Avatar player={m} />
              <div>
                <strong>{m.name}</strong>
                <time>
                  {new Date(m.ts).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
                <p>{m.text}</p>
              </div>
            </div>
          ))
        ) : (
          <div className="empty-feed">
            <Icon name="chat" size={32} />
            <strong>Let the mind games begin.</strong>
            <p>A bold claim deserves a little banter.</p>
          </div>
        )}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) {
            onSend(text);
            setText("");
          }
        }}
      >
        <input
          aria-label="Chat message"
          disabled={!enabled}
          value={text}
          maxLength={280}
          placeholder="Type a message…"
          onChange={(e) => setText(e.target.value)}
        />
        <button aria-label="Send message" disabled={!enabled || !text.trim()}>
          <Icon name="send" />
        </button>
      </form>
    </section>
  );
}
export function Challenge({ claim, onConfirm }) {
  const [picks, setPicks] = useState([]);
  if (!claim)
    return (
      <>
        <h2>Claim closed</h2>
        <p>Check the table for the next move.</p>
      </>
    );
  return (
    <>
      <div className="challenge-title">
        <Mask size={48} />
        <h2>Call Bluff?</h2>
      </div>
      <p className="center">
        {claim.playerName} claims{" "}
        <b className="gold">
          {claim.cardCount} {rankName(claim.declaredRank)}
        </b>
        .
      </p>
      <div className="challenge-outcomes">
        <div>
          <Icon name="check" />
          <b>If you find a false card</b>
          <p>They pick up the entire pile.</p>
        </div>
        <div>
          <Icon name="close" />
          <b>If all chosen cards are true</b>
          <p>You pick up the entire pile.</p>
        </div>
      </div>
      <p className="center">
        Choose exactly {claim.requiredPickCount} card
        {claim.requiredPickCount > 1 ? "s" : ""} to inspect.
      </p>
      <div className="challenge-cards">
        {Array.from({ length: claim.cardCount }, (_, i) => (
          <button
            aria-label={`Inspect card ${i + 1}`}
            aria-pressed={picks.includes(i)}
            className={picks.includes(i) ? "picked" : ""}
            key={i}
            onClick={() =>
              setPicks((p) =>
                p.includes(i)
                  ? p.filter((x) => x !== i)
                  : p.length < claim.requiredPickCount
                    ? [...p, i]
                    : p,
              )
            }
          >
            <Back />
          </button>
        ))}
      </div>
      <button
        className="primary wide"
        disabled={picks.length !== claim.requiredPickCount}
        onClick={() => onConfirm(picks)}
      >
        <Icon name="alert" />
        Call Bluff · Reveal Cards
      </button>
    </>
  );
}
export function RoundResult({ result, host, onContinue }) {
  return (
    <div className="round-result">
      <div className="overline">REVEAL & ROUND RESULT</div>
      <h1>
        {result?.foundFake
          ? "Bluff Caught!"
          : result?.type === "pass"
            ? "The Claim Stands"
            : "They Told the Truth!"}
      </h1>
      <p>{result?.message}</p>
      {!!result?.revealCards?.length && (
        <div className="result-cards">
          {result.revealCards.map((card) => (
            <Card key={card.id} card={card} />
          ))}
        </div>
      )}
      <div className="pickup-note">
        <Icon name="cards" />
        <span>
          {result?.loserName ? (
            <>
              <b>{result.loserName}</b> picks up {result.pileCount} card
              {result.pileCount === 1 ? "" : "s"}
            </>
          ) : (
            "The pile clears. A new rank awaits."
          )}
        </span>
      </div>
      {host ? (
        <button className="primary" onClick={onContinue}>
          <Icon name="skip" />
          Next Round
        </button>
      ) : (
        <p className="muted">Waiting for the host to start the next round…</p>
      )}
    </div>
  );
}
export function Results({ state, me, onRematch, onHome }) {
  const winner = state.players.find((p) => p.id === state.winnerId),
    won = winner?.id === me.id;
  const standings = [...state.players].sort((a, b) =>
    a.id === winner?.id
      ? -1
      : b.id === winner?.id
        ? 1
        : state.playerHandsCount[a.id] - state.playerHandsCount[b.id],
  );
  return (
    <main className="results-page">
      <div className="win-heading">
        <Icon name="crown" size={66} />
        <p className="overline">GAME COMPLETE · FINAL RESULT</p>
        <h1>{won ? `You (${me.name}) Win!` : `${winner?.name} Wins!`}</h1>
        <p>
          {won
            ? "You kept your cool. You fooled the table."
            : "A great game. An even better rematch awaits."}
        </p>
      </div>
      <section className="panel result-summary">
        <h3>
          <Icon name="cards" />
          Match Summary
        </h3>
        <Stat icon="flag" label="Rounds played" value={state.roundNumber} />
        <Stat icon="users" label="Players" value={state.players.length} />
        <Stat
          icon="cards"
          label="Your cards left"
          value={state.playerHandsCount[me.id]}
        />
        <div className="final-truth">
          <Mask size={40} />
          <p>
            {won
              ? "Your final claim survived the table."
              : "Every hand is a new chance."}
          </p>
        </div>
      </section>
      <section className="winner-showcase">
        <div className="winner-crown">
          <Icon name="crown" size={72} />
        </div>
        <Fan />
        <Avatar player={winner} large />
        <div className="winner-plinth">
          WINNER<small>{winner?.name}</small>
        </div>
      </section>
      <section className="panel final-standings">
        <h3>
          <Icon name="trophy" />
          Final Standings
        </h3>
        {standings.map((p, i) => (
          <div className={`standing ${i === 0 ? "winner" : ""}`} key={p.id}>
            <strong className="position">{i + 1}</strong>
            <Avatar player={p} />
            <div>
              <b>{p.id === me.id ? `You (${p.name})` : p.name}</b>
              <small>
                {i === 0 ? "Winner" : p.isBot ? "AI opponent" : "Player"}
              </small>
            </div>
            <strong>
              {state.playerHandsCount[p.id]}
              <small>cards left</small>
            </strong>
          </div>
        ))}
      </section>
      <div className="result-actions">
        {state.hostId === me.id && (
          <button className="primary" onClick={onRematch}>
            <Icon name="refresh" />
            Rematch<small>Same group. Fresh deck.</small>
          </button>
        )}
        <button className="secondary" onClick={onHome}>
          <Icon name="home" />
          Return to Menu<small>Your next table is waiting.</small>
        </button>
      </div>
    </main>
  );
}

export function RankPicker({ value, onChange, count, locked = false }) {
  const [open, setOpen] = useState(false),
    root = useRef(null),
    trigger = useRef(null),
    selectedOption = useRef(null);
  useEffect(() => {
    if (!open) return;
    selectedOption.current?.focus();
    const dismiss = (e) => {
      if (!root.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);
  useEffect(() => {
    if (locked) setOpen(false);
  }, [locked]);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  return (
    <div
      className="rank-control"
      ref={root}
      onKeyDown={(e) => {
        if (e.key === "Escape") close();
      }}
    >
      <button
        ref={trigger}
        type="button"
        className={`rank-trigger ${locked ? "locked" : ""}`}
        disabled={locked}
        aria-label={
          locked
            ? `Table rank: ${rankName(value)}`
            : `Claim a rank: ${rankName(value)}`
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="rank-symbol">{value}</span>
        <span className="rank-trigger-copy">
          <small>{locked ? "TABLE RANK · LOCKED" : "CLAIM A RANK"}</small>
          <strong>{rankName(value)}</strong>
        </span>
        <Icon name={locked ? "lock" : "cards"} size={18} />
      </button>
      {open && !locked && (
        <div
          className="rank-popover"
          role="dialog"
          aria-label="Choose your claimed rank"
        >
          <div className="rank-popover-heading">
            <div>
              <strong>What’s your claim?</strong>
              <p>Pick the rank you want the table to believe.</p>
            </div>
            <button
              type="button"
              aria-label="Close rank picker"
              onClick={close}
            >
              <Icon name="close" size={17} />
            </button>
          </div>
          <div className="rank-options" role="group" aria-label="Card ranks">
            {RANKS.map((rank) => (
              <button
                type="button"
                key={rank}
                ref={rank === value ? selectedOption : null}
                aria-label={`Claim ${rankName(rank)}`}
                aria-pressed={rank === value}
                className={rank === value ? "chosen" : ""}
                onClick={() => {
                  onChange(rank);
                  close();
                }}
                onKeyDown={(e) => {
                  if (
                    ![
                      "ArrowRight",
                      "ArrowLeft",
                      "ArrowDown",
                      "ArrowUp",
                      "Home",
                      "End",
                    ].includes(e.key)
                  )
                    return;
                  e.preventDefault();
                  const index = RANKS.indexOf(rank),
                    next =
                      e.key === "Home"
                        ? 0
                        : e.key === "End"
                          ? 12
                          : (index +
                              {
                                ArrowRight: 1,
                                ArrowLeft: -1,
                                ArrowDown: 7,
                                ArrowUp: -7,
                              }[e.key] +
                              13) %
                            13;
                  e.currentTarget.parentElement.children[next]?.focus();
                }}
              >
                <b>{rank}</b>
                <span>♠</span>
                {rank === value && <i />}
              </button>
            ))}
          </div>
          <div className="rank-preview">
            <Mask size={23} />
            <span>
              {count ? (
                <>
                  You’ll claim{" "}
                  <b>
                    {count} {rankName(value, count)}
                  </b>
                </>
              ) : (
                <>
                  Selected claim: <b>{rankName(value)}</b>
                </>
              )}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// Place cards from the measured centre instead of accumulating negative margins.
export function HandFan({ cards, selected, expanded, onToggle }) {
  const root = useRef(null);
  const [dimensions, setDimensions] = useState({ width: 400, cardWidth: 94 });
  useEffect(() => {
    const element = root.current;
    const measure = () => {
      const width = element.clientWidth;
      const cardWidth =
        parseFloat(
          getComputedStyle(element).getPropertyValue("--hand-card-width"),
        ) || 94;
      setDimensions((current) =>
        current.width === width && current.cardWidth === cardWidth
          ? current
          : { width, cardWidth },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const step =
    cards.length > 1
      ? Math.min(
          dimensions.cardWidth * 0.67,
          Math.max(0, dimensions.width - dimensions.cardWidth - 36) /
            (cards.length - 1),
        )
      : 0;
  return (
    <div
      ref={root}
      className={`hand ${expanded ? "expanded" : ""}`}
      aria-label="Your cards"
    >
      {cards.map((card, index) => {
        const centre = index - (cards.length - 1) / 2;
        const normalized =
          cards.length > 1 ? centre / ((cards.length - 1) / 2) : 0;
        return (
          <Card
            key={card.id}
            card={card}
            selected={selected.includes(card.id)}
            onClick={() => onToggle(card.id)}
            style={{
              "--fan-offset": `${centre * step}px`,
              "--fan-angle": `${normalized * Math.min(9, (cards.length - 1) * 1.7)}deg`,
              "--fan-arc": `${-8 * (1 - normalized * normalized)}px`,
              "--fan-order": index,
            }}
          />
        );
      })}
    </div>
  );
}
