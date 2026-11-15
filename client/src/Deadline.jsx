import React, { useSyncExternalStore } from "react";
import { serverTime, subscribeClock } from "./lib/clock";
export default function Deadline({ deadline, prefix = "", suffix = "s" }) {
  const seconds = useSyncExternalStore(subscribeClock, () =>
    Math.max(0, Math.ceil((deadline - serverTime()) / 1000)),
  );
  return (
    <span>
      {prefix}
      {seconds}
      {suffix}
    </span>
  );
}
