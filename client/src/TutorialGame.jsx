import { manageDialogFocus } from "./lib/dialog-focus";
import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  Avatar,
  Back,
  Card,
  Challenge,
  Icon,
  Mask,
  RankPicker,
} from "./components";
const DEAL = [
  { id: "jack-heart", rank: "J", suit: "H" },
  { id: "jack-club", rank: "J", suit: "C" },
  { id: "four-spade", rank: "4", suit: "S" },
  { id: "queen-diamond", rank: "Q", suit: "D" },
];
const EVIDENCE = [
  { id: "neel-queen", rank: "Q", suit: "H" },
  { id: "neel-seven", rank: "7", suit: "S" },
];
const LESSONS = [
  {
    title: "Make your first claim",
    body: "Select both Jacks in your hand. Choose Jacks in the rank picker, then play them face down. The table sees your claim, not your cards.",
    hint: "Select J♥ and J♣, then choose Jacks.",
  },
  {
    title: "Your claim stands",
    body: "Bot 2 and Bot 1 both pass. Your two cards stay out of your hand, and the pile clears. You are two cards closer to winning.",
    hint: "When everyone passes, the claimant starts a fresh pile.",
  },
  {
    title: "Something doesn’t add up…",
    body: "In the next practice hand, Bot 1 claims 2 Jacks. You can trust the claim or call bluff. Let’s challenge it and choose a card to reveal.",
    hint: "For 2 played cards, inspect 1. For larger claims, inspect half, rounded down.",
  },
  {
    title: "You caught the bluff!",
    body: "That card is not a Jack. Bot 1 must pick up the whole pile. You won the challenge and would start the next round.",
    hint: "Any false card you inspect catches the bluff. If all inspected cards are true, you take the pile.",
  },
  {
    title: "Know when to pass",
    body: "In this practice round, Bot 2 starts with a claim of 1 Ace. Passing accepts her claim without revealing it. Try passing now.",
    hint: "Passing costs no cards. If everyone passes, the pile clears.",
  },
  {
    title: "Try a little deception",
    body: "Now select both of your remaining cards and claim 2 Queens. Your 4 is not a Queen, so this is a bluff. A claim does not have to match your cards.",
    hint: "Select 4♠ and Q♦, then claim Queens. This practice table will let the claim stand.",
  },
  {
    title: "One last test",
    body: "Your hand is empty, but the game is not over yet. Opponents must pass or challenge your final claim. They cannot play over it.",
    hint: "A caught final bluff puts the pile back in your hand. A claim that survives wins the game.",
  },
  {
    title: "Your poker face is ready",
    body: "Both opponents passed your final claim. You emptied your hand and won the practice game. You now know how to claim, challenge, pass, and finish. In live games, three missed turns activate temporary AI. Use Take Control to return; only a legal human gameplay action clears AFK strikes.",
    hint: "Real opponents choose their own responses. Keep them guessing!",
  },
];
export default function TutorialGame({ player, onComplete, busy }) {
  const [step, setStep] = useState(0),
    [selected, setSelected] = useState([]),
    [rank, setRank] = useState("A"),
    [inspecting, setInspecting] = useState(false),
    [reveal, setReveal] = useState(null);
  useEffect(() => {
    if (inspecting)
      return manageDialogFocus(
        document.querySelector(".tutorial-inspection"),
        () => setInspecting(false),
      );
  }, [inspecting]);
  const hand = step === 0 ? DEAL : step >= 6 ? [] : DEAL.slice(2),
    lesson = LESSONS[step];
  const actionable = step === 0 || step === 5;
  const valid =
    step === 0
      ? selected.length === 2 &&
        selected.every((id) => id.startsWith("jack-")) &&
        rank === "J"
      : selected.length === 2 && rank === "Q";
  const toggle = (id) => {
    if (actionable)
      setSelected((current) =>
        current.includes(id)
          ? current.filter((card) => card !== id)
          : [...current, id],
      );
  };
  const advance = (next) => {
    setSelected([]);
    setStep(next);
    if (next === 5) setRank("Q");
  };
  const group = [0, 0, 1, 1, 2, 3, 3, 4][step];
  const neel = { name: "Bot 1", avatar: 0 },
    priya = { name: "Bot 2", avatar: 1 };
  const pileCount =
    step === 0 ? 0 : step === 2 ? 2 : step === 4 ? 1 : step === 6 ? 2 : 0;
  const claim =
    step === 2
      ? "Bot 1 claims 2 Jacks"
      : step === 4
        ? "Bot 2 claims 1 Ace"
        : step === 6
          ? "You claim 2 Queens"
          : step === 1
            ? "Everyone passed"
            : step === 3
              ? "Bluff caught"
              : step === 7
                ? "You win!"
                : "Your turn";
  return (
    <div className="tutorial-game">
      <div className="overline">
        GUIDED PRACTICE · SMALL DEAL · NO MATCH STATS
      </div>
      <div className="tutorial-heading">
        <h2>Learn the art of the bluff.</h2>
        <span>Step {Math.min(step + 1, 8)} of 8</span>
      </div>
      <ol className="tutorial-progress" aria-label="Tutorial progress">
        {["Claim", "Challenge", "Pass", "Finish"].map((label, i) => (
          <li
            key={label}
            className={group > i ? "done" : group === i ? "current" : ""}
          >
            <span>{group > i ? "✓" : i + 1}</span>
            {label}
          </li>
        ))}
      </ol>
      <div className="tutorial-layout">
        <section className="tutorial-table" aria-label="Practice table">
          <div className="tutorial-opponents">
            {[priya, neel].map((p) => (
              <div className="tutorial-player" key={p.name}>
                <Avatar player={p} />
                <div>
                  <strong>{p.name}</strong>
                  <small>
                    {p.name === "Bot 1"
                      ? step >= 3
                        ? 4
                        : step === 2
                          ? 2
                          : 4
                      : step >= 4
                        ? 3
                        : 4}{" "}
                    cards
                  </small>
                </div>
              </div>
            ))}
          </div>
          <div
            className={`tutorial-claim ${step === 7 ? "won" : ""}`}
            aria-live="polite"
          >
            <Mask size={30} />
            <strong>{claim}</strong>
          </div>
          <div className="tutorial-pile">
            {step === 3 && reveal ? (
              <Card card={reveal} />
            ) : step === 7 ? (
              <Icon name="trophy" size={63} />
            ) : (
              <>
                <Back />
                <span>{pileCount} cards in pile</span>
              </>
            )}
          </div>
          <div className="tutorial-you">
            <Avatar player={player} />
            <span>
              You ({player.name || "Player"})
              <small>{hand.length} cards left</small>
            </span>
          </div>
          <div
            className={`tutorial-hand ${actionable ? "" : "inactive"}`}
            aria-label="Practice hand"
          >
            {hand.map((card) => (
              <Card
                key={card.id}
                card={card}
                selected={selected.includes(card.id)}
                onClick={() => toggle(card.id)}
              />
            ))}
          </div>
          {!hand.length && (
            <div className="tutorial-empty">
              {step === 7
                ? "Empty hand. Well played."
                : "Empty hand — waiting for the table."}
            </div>
          )}
        </section>
        <section className="tutorial-guide">
          <div className="overline">
            {step === 7 ? "TUTORIAL COMPLETE" : "YOUR NEXT MOVE"}
          </div>
          <h3>{lesson.title}</h3>
          <p>{lesson.body}</p>
          <div className="tutorial-tip">
            <Icon name="book" size={19} />
            <span>{lesson.hint}</span>
          </div>
          {actionable && (
            <>
              <div className="tutorial-rank">
                <RankPicker
                  value={rank}
                  onChange={setRank}
                  count={selected.length}
                />
              </div>
              <p className="tutorial-selection" aria-live="polite">
                {selected.length
                  ? `${selected.length} card${selected.length === 1 ? "" : "s"} selected`
                  : "Choose your cards from the practice hand."}
                {step === 0 && selected.some((id) => !id.startsWith("jack-"))
                  ? " · For this first claim, use only the two Jacks."
                  : ""}
              </p>
              <button
                className="primary wide"
                disabled={!valid}
                onClick={() => advance(step === 0 ? 1 : 6)}
              >
                <Icon name="cards" />
                Play Face Down
              </button>
            </>
          )}
          {step === 1 && (
            <button className="primary wide" onClick={() => advance(2)}>
              Practice Calling Bluff
              <Icon name="arrow" size={18} />
            </button>
          )}
          {step === 2 && (
            <button
              className="primary wide"
              onClick={() => setInspecting(true)}
            >
              <Icon name="alert" />
              Call Bluff
            </button>
          )}
          {step === 3 && (
            <button className="primary wide" onClick={() => advance(4)}>
              Practice Passing
              <Icon name="arrow" size={18} />
            </button>
          )}
          {step === 4 && (
            <button className="primary wide" onClick={() => advance(5)}>
              <Icon name="skip" />
              Pass
            </button>
          )}
          {step === 5 && (
            <p className="tutorial-passed">
              <Icon name="check" size={15} />
              You passed. Bot 1 passed too, so Bot 2’s pile cleared.
            </p>
          )}
          {step === 6 && (
            <button className="primary wide" onClick={() => advance(7)}>
              Let the Table Respond
              <Icon name="users" size={19} />
            </button>
          )}
          {step === 7 && (
            <button
              className="primary wide"
              disabled={busy}
              onClick={onComplete}
            >
              <Icon name="check" />
              {busy ? "Saving…" : "Finish Tutorial"}
            </button>
          )}
        </section>
      </div>
      {inspecting &&
        createPortal(
          <div
            className="tutorial-inspection"
            role="dialog"
            aria-modal="true"
            aria-label="Practice bluff challenge"
          >
            <div className="panel tutorial-evidence">
              <Challenge
                claim={{
                  playerName: "Bot 1",
                  cardCount: 2,
                  declaredRank: "J",
                  requiredPickCount: 1,
                }}
                onConfirm={(indexes) => {
                  setReveal(EVIDENCE[indexes[0]]);
                  setInspecting(false);
                  advance(3);
                }}
              />
              <button
                className="text-button"
                onClick={() => setInspecting(false)}
              >
                Back to the practice table
              </button>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
