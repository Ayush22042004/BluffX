import React from "react";
import { version } from "../package.json";
export default function ReleaseBanner() {
  return (
    <div className="release-banner">
      <b>BETA</b>
      <span>BluffX is in beta. Small glitches may occur.</span>
      <small>v{version}</small>
    </div>
  );
}
