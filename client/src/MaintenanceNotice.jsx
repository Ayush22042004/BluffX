import React, { useEffect, useRef, useState } from "react";
import { API_URL } from "./lib/endpoints";
import { socket, setSocketEnabled } from "./lib/socket";
import { BetaVersion } from "./DisplayHints";
import "./maintenance.css";

export default function MaintenanceNotice({ children }) {
  const [maintenance, setMaintenance] = useState(false);
  const [checking, setChecking] = useState(false);
  const content = useRef(null), heading = useRef(null), retry = useRef(() => {});
  useEffect(() => {
    let active = true, confirmed = false, timer, controller, pending = false, lastCheck = 0;
    const schedule = () => {
      clearTimeout(timer);
      if (active && confirmed) timer = setTimeout(() => probe(true), 30000);
    };
    const show = () => {
      if (!active) return;
      confirmed = true;
      setMaintenance(true);
      setSocketEnabled(false);
      schedule();
    };
    async function probe(force = false) {
      if (!active || pending || (!force && Date.now() - lastCheck < 10000)) return;
      pending = true;
      lastCheck = Date.now();
      setChecking(true);
      controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetch(`${API_URL}/health`, { credentials: "omit", cache: "no-store", signal: controller.signal });
        const state = await response.json();
        if (!active) return;
        if (state.maintenance === true || state.code === "SERVER_MAINTENANCE") show();
        else if (confirmed && response.ok && state.ok === true && state.ready !== false)
          window.location.reload();
      } catch { /* Network failures and cold starts are not maintenance announcements. */ }
      finally {
        clearTimeout(timeout);
        pending = false;
        if (active) { setChecking(false); schedule(); }
      }
    }
    retry.current = () => probe(true);
    const failed = () => probe();
    window.addEventListener("bluffx:maintenance", show);
    window.addEventListener("online", failed);
    socket.on("disconnect", failed);
    socket.on("connect_error", failed);
    probe();
    return () => {
      active = false;
      controller?.abort();
      clearTimeout(timer);
      window.removeEventListener("bluffx:maintenance", show);
      window.removeEventListener("online", failed);
      socket.off("disconnect", failed);
      socket.off("connect_error", failed);
    };
  }, []);
  useEffect(() => {
    if (maintenance) {
      content.current?.setAttribute("inert", "");
      heading.current?.focus();
    } else content.current?.removeAttribute("inert");
  }, [maintenance]);
  return <>
    <div className="maintenance-content" ref={content} aria-hidden={maintenance || undefined}>{children}</div>
    {maintenance && <section className="maintenance-screen" aria-labelledby="maintenance-title" aria-describedby="maintenance-description">
      <div className="maintenance-card">
        <div className="maintenance-brand"><img src="/bluffx.ico" alt="" /><span>Bluff<span>X</span></span><BetaVersion /></div>
        <span className="maintenance-label"><i aria-hidden="true" /> Scheduled maintenance</span>
        <h1 id="maintenance-title" ref={heading} tabIndex={-1}>A quick break.<br /><span>A better table.</span></h1>
        <p id="maintenance-description">BluffX is temporarily offline while we make an update. Please keep this page open—we’ll reconnect you when the table is ready.</p>
        <div className="maintenance-status" role="status">{checking ? "Checking server status…" : "Waiting for BluffX to return"}</div>
        <button type="button" disabled={checking} onClick={() => retry.current()}>{checking ? "Checking…" : "Check again"}</button>
        <small>Your account and saved records remain in place.</small>
      </div>
    </section>}
  </>;
}
