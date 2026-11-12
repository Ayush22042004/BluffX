import React, { Component, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AuthProvider } from "./auth";
import "./index.css";

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
    // Keep details in dev console for debugging while showing a friendly fallback in UI.
    // eslint-disable-next-line no-console
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
          <h1 style={{ margin: 0, fontSize: "28px" }}>BluffX failed to load</h1>
          <p style={{ marginTop: "10px", opacity: 0.9 }}>
            Frontend hit an error. Hard refresh the page. If it persists,
            restart client and server.
          </p>
          <pre
            style={{ marginTop: "14px", whiteSpace: "pre-wrap", opacity: 0.85 }}
          >
            {this.state.message}
          </pre>
        </div>
      );
    }

    return this.props.children;
  }
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <RootErrorBoundary>
      <AuthProvider>
        <App />
      </AuthProvider>
    </RootErrorBoundary>
  </StrictMode>,
);
