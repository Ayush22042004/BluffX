import React, { useState } from "react";
const KEY = "bluffx:preferences:v1";
export function readPreferences() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || {};
  } catch {
    return {};
  }
}
export function applyPreferences(p) {
  document.documentElement.dataset.reduceMotion = p.reduceMotion
    ? "true"
    : "false";
}
export default function Preferences() {
  const [p, setP] = useState(readPreferences);
  const update = (key, value) =>
    setP((old) => {
      const next = { ...old, [key]: value };
      localStorage.setItem(KEY, JSON.stringify(next));
      applyPreferences(next);
      return next;
    });
  return (
    <section>
      <h2>Player preferences</h2>
      <p>These harmless display preferences stay in this browser.</p>
      <label className="preference-row">
        <input
          type="checkbox"
          checked={!!p.reduceMotion}
          onChange={(e) => update("reduceMotion", e.target.checked)}
        />
        Reduce motion
      </label>
      <p>
        Microphone, listening volume, deafen and noise reduction are controlled
        in Table Voice. Browser permissions still apply.
      </p>
    </section>
  );
}
