import React, { Component, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import DisplayHints from "./DisplayHints";
import MaintenanceNotice from "./MaintenanceNotice";
import { AuthProvider } from "./auth";
import "./index.css";
import "./theme-ui.css";
import "./table-settings.css";
import { applyPreferences, readPreferences } from "./Preferences";
applyPreferences(readPreferences());
import { reportDiagnostic } from "./lib/diagnostics";
window.addEventListener("error", () => reportDiagnostic("WINDOW_ERROR"));
window.addEventListener("unhandledrejection", () =>
  reportDiagnostic("UNHANDLED_REJECTION"),
);

class RootErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, message: "" };
  }

  static getDerivedStateFromError(error) {
    return {
      hasError: true,
      message: error?.message || "Unknown render error",
    };
  }

  componentDidCatch(error, info) {
    reportDiagnostic("CLIENT_RENDER_ERROR");
    // Keep details in dev console for debugging while showing a friendly fallback in UI.
    console.error("Root render failure", error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            minHeight: "100vh",
            background: "#081b29",
            color: "#e7f4ff",
            padding: "24px",
          }}
        >
          <h1 style={{ margin: 0, fontSize: "28px" }}>Let’s reconnect.</h1>
          <p style={{ marginTop: "10px", opacity: 0.9 }}>
            Reload the page to return to your table.
          </p>
          <button onClick={() => window.location.reload()}>
            Reload BluffX
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <RootErrorBoundary>
      <MaintenanceNotice>
        <DisplayHints />
        <AuthProvider>
          <App />
        </AuthProvider>
      </MaintenanceNotice>
    </RootErrorBoundary>
  </StrictMode>,
);
