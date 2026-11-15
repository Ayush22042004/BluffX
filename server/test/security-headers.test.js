const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const { CSP, securityHeaders } = require("../src/security-headers");
const { DeadlineScheduler } = require("../src/deadline-scheduler");

test("security policies cover proxied frontend and backend without enforcing an unqualified CSP", async () => {
  const app = express();
  app.disable("x-powered-by");
  app.use(securityHeaders);
  app.get("/", (_req, res) => res.json({ ok: true }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const response = await fetch(`http://localhost:${server.address().port}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(response.headers.get("x-powered-by"), null);
    assert.equal(response.headers.get("content-security-policy"), null);
    assert.equal(
      response.headers.get("content-security-policy-report-only"),
      CSP,
    );
    assert.match(
      response.headers.get("permissions-policy"),
      /microphone=\(self\)/,
    );
    const frontend = require("../../client/vercel.json").headers[0].headers;
    assert.equal(
      frontend.find((h) => h.key === "Content-Security-Policy-Report-Only")
        .value,
      CSP,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("scheduler reports failures and continues with later deadlines", async () => {
  let failures = 0,
    calls = 0;
  const scheduler = new DeadlineScheduler(
    async (id) => {
      calls++;
      if (id === "bad") throw Error("private details");
    },
    { onError: () => failures++ },
  );
  try {
    scheduler.set("bad", Date.now());
    scheduler.set("good", Date.now() + 10);
    for (let n = 0; n < 30 && calls < 2; n++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(calls, 2);
    assert.equal(failures, 1);
    assert.equal(scheduler.running.size, 0);
  } finally {
    scheduler.close();
  }
});
