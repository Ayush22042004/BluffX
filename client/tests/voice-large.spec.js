import { test, expect, chromium } from "@playwright/test";
import { writeFileSync, mkdirSync } from "node:fs";
test("opt-in local ten-person mesh resource sample without TURN usage", async () => {
  test.skip(
    process.env.BLUFFX_LARGE_VOICE !== "true",
    "Explicit local resource experiment; no cloud media usage.",
  );
  test.setTimeout(120000);
  const browser = await chromium.launch({
    channel: "chrome",
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--disable-background-timer-throttling",
    ],
  });
  const pages = [];
  try {
    let roomId;
    for (let i = 0; i < 10; i++) {
      const c = await browser.newContext({
        baseURL: "http://localhost:5180",
        permissions: ["microphone"],
      });
      const page = await c.newPage();
      pages.push(page);
      await page.addInitScript((i) => {
        sessionStorage.setItem("bluffx:guest", "true");
        localStorage.setItem(
          "bluffx:profile",
          JSON.stringify({ name: `Voice ${i}`, avatar: 0 }),
        );
        window.__pcs = [];
        const Base = window.RTCPeerConnection;
        window.RTCPeerConnection = class extends Base {
          constructor(...args) {
            super(...args);
            window.__pcs.push(this);
          }
        };
      }, i);
      if (i === 0) {
        await page.goto("/");
        await page
          .locator("nav")
          .getByRole("button", { name: "Create Room", exact: true })
          .click();
        await page.getByRole("button", { name: "10", exact: true }).click();
        await page.locator(".start-button").click();
        roomId = (await page.locator(".room-code").innerText()).trim();
      } else {
        await page.goto("/?room=" + roomId);
        await page
          .getByRole("button", { name: "Join Room", exact: true })
          .last()
          .click();
      }
      await page
        .getByRole("button", { name: "Join Voice", exact: true })
        .click();
    }
    for (const page of pages)
      await expect
        .poll(
          () =>
            page.evaluate(
              () =>
                window.__pcs.filter((p) => p.connectionState === "connected")
                  .length,
            ),
          { timeout: 30000 },
        )
        .toBe(9);
    await pages[0]
      .getByRole("button", { name: "Unmute Mic", exact: true })
      .click();
    const stats = (page) =>
      page.evaluate(async () => {
        let sent = 0,
          received = 0,
          lost = 0,
          packets = 0,
          jitter = 0;
        for (const p of window.__pcs)
          for (const s of (await p.getStats()).values()) {
            if (s.type === "outbound-rtp" && s.kind === "audio")
              sent += s.bytesSent || 0;
            if (s.type === "inbound-rtp" && s.kind === "audio") {
              received += s.bytesReceived || 0;
              lost += Math.max(0, s.packetsLost || 0);
              packets += s.packetsReceived || 0;
              jitter = Math.max(jitter, s.jitter || 0);
            }
          }
        return {
          sent,
          received,
          lost,
          packets,
          maxJitterSeconds: jitter,
          heapBytes: performance.memory?.usedJSHeapSize ?? null,
          connections: window.__pcs.length,
        };
      });
    await expect
      .poll(
        async () =>
          Math.min(
            ...(await Promise.all(
              pages.slice(1).map(async (p) => (await stats(p)).received),
            )),
          ),
        { timeout: 15000 },
      )
      .toBeGreaterThan(0);
    const before = await stats(pages[0]),
      start = Date.now();
    await new Promise((r) => setTimeout(r, 3000));
    const elapsed = Date.now() - start;
    const after = await stats(pages[0]),
      receivers = await Promise.all(pages.slice(1).map(stats));
    const frames = await pages[0].evaluate(
      () =>
        new Promise((resolve) => {
          let n = 0;
          const start = performance.now();
          function frame() {
            n++;
            const elapsed = performance.now() - start;
            if (elapsed >= 1000) resolve((n * 1000) / elapsed);
            else requestAnimationFrame(frame);
          }
          requestAnimationFrame(frame);
        }),
    );
    const output = {
      at: new Date().toISOString(),
      participants: 10,
      meshConnections: 90,
      simultaneousSpeakers: 1,
      source:
        "local Chrome synthetic microphone, lobby, memory persistence test double, no TURN",
      senderRtpKbps: ((after.sent - before.sent) * 8) / elapsed,
      hostJsHeapBytes: after.heapBytes,
      headlessAnimationFramesPerSecond: frames,
      receivers,
      limits:
        "Not mobile/device quality, gameplay FPS, Render CPU/memory, ten simultaneous speakers, physical network bandwidth or SFU comparison. RTP bytes exclude transport overhead.",
    };
    mkdirSync("tests/artifacts", { recursive: true });
    writeFileSync(
      "tests/artifacts/v3-ten-voice.json",
      JSON.stringify(output, null, 2),
    );
    console.log(JSON.stringify(output));
  } finally {
    await browser.close();
  }
});
