import React, { useState } from "react";
const KEY = "bluffx:preferences:v1";
export const THEMES = [
  { id: "blue", name: "Neon Blue", description: "Navy · electric blue · cyan · gold" },
  { id: "pink", name: "Neon Pink", description: "Plum · rose · violet · peach" },
  { id: "emerald", name: "Neon Emerald", description: "Charcoal · emerald · teal · champagne" },
];
export function readPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    return saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  } catch {
    return {};
  }
}
export function applyPreferences(p) {
  document.documentElement.dataset.theme = THEMES.some((t) => t.id === p.theme)
    ? p.theme
    : "blue";
  document.documentElement.dataset.reduceMotion = p.reduceMotion
    ? "true"
    : "false";
}
export default function Preferences() {
  const [p, setP] = useState(readPreferences);
  const update = (key, value) =>
    setP((old) => {
      const next = { ...old, [key]: value };
      try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* Session-only when storage is blocked. */ }
      applyPreferences(next);
      return next;
    });
  return (
    <section>
      <h2>Player preferences</h2>
      <p>These harmless display preferences stay in this browser.</p>
      <fieldset className="theme-picker">
        <legend>Choose your theme</legend>
        <div className="theme-options">
          {THEMES.map((theme) => (
            <label key={theme.id} className={`theme-option theme-preview-${theme.id}`}>
              <input type="radio" name="theme" value={theme.id}
                checked={(THEMES.some((t) => t.id === p.theme) ? p.theme : "blue") === theme.id}
                onChange={() => update("theme", theme.id)} />
              <span className="theme-swatch" aria-hidden="true"><i /><i /><i /><i /></span>
              <strong>{theme.name}</strong>
              <small>{theme.description}</small>
            </label>
          ))}
        </div>
      </fieldset>
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
