import React, { useEffect, useState } from "react";
export const VERSION = import.meta.env.VITE_APP_VERSION || "0.3.0";
export function BetaVersion() {
  return (
    <small className="beta-version" title="BluffX is still in beta">
      <b>BETA</b>
      <span>v{VERSION}</span>
    </small>
  );
}
export default function DisplayHints() {
  const [visible, setVisible] = useState(
    () => matchMedia("(min-width: 900px) and (pointer: fine)").matches,
  );
  useEffect(() => {
    const dismiss = () => {
      if (document.fullscreenElement) setVisible(false);
    };
    const key = (e) => {
      if (e.key === "F11") setVisible(false);
    };
    document.addEventListener("fullscreenchange", dismiss);
    window.addEventListener("resize", dismiss);
    window.addEventListener("keydown", key);
    const timer = setTimeout(() => setVisible(false), 12000);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("fullscreenchange", dismiss);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("keydown", key);
    };
  }, []);
  if (!visible) return null;
  const mac = /Mac/.test(navigator.platform);
  return (
    <aside className="fullscreen-tip" role="status" aria-live="polite">
      <span className="fullscreen-tip-icon" aria-hidden="true">
        ⛶
      </span>
      <div>
        <strong>A better view of the table</strong>
        <p>
          Fullscreen recommended. Press <kbd>{mac ? "⌃ ⌘ F" : "F11"}</kbd> to
          play with more room.
        </p>
      </div>
      <button
        aria-label="Dismiss fullscreen recommendation"
        onClick={() => setVisible(false)}
      >
        ×
      </button>
    </aside>
  );
}
