import React from "react";
export default function SpeakingBadge() {
  return (
    <span className="speaking-badge" aria-label="Speaking">
      <span className="speaking-wave" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      Speaking
    </span>
  );
}
