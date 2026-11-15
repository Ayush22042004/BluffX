import { test, expect } from "@playwright/test";
import helper from "../../server/test/socket-client.cjs";
const event = (socket, name, predicate = () => true) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { socket.off(name, handler); reject(Error("Timeout " + name)); }, 10000);
  const handler = data => { if (predicate(data)) { clearTimeout(timer); socket.off(name, handler); resolve(data); } };
  socket.on(name, handler);
});
test("a saved casual victory updates the personal record across reload without becoming a ranked win", async ({ page }) => {
  const signup = await page.request.post("http://localhost:4020/auth/signup", { data: { name: "Casual Winner", email: `casual-ui-${Date.now()}@example.com`, password: "CasualRecordPass123!" } });
  expect(signup.status()).toBe(201);
  await page.request.post("http://localhost:4020/auth/tutorial", { data: { status: "completed" } });
  let peer;
  try {
    await page.goto("/");
    await page.locator("nav").getByRole("button", { name: "Create Room", exact: true }).click();
    await page.getByRole("button", { name: "2", exact: true }).click();
    await page.locator(".start-button").click();
    const code = (await page.locator(".room-code").innerText()).trim();
    peer = helper.io("http://localhost:4020", { autoConnect: false, transports: ["websocket"] });
    const ready = event(peer, "server_ready"); peer.connect(); await ready;
    let pending = event(peer, "room_state"); peer.emit("join_room", { roomId: code, name: "Casual Guest" }); await pending;
    pending = event(peer, "room_state", s => s.you.ready); peer.emit("set_ready", { ready: true }); await pending;
    await page.getByRole("button", { name: "Start Match", exact: true }).click();
    await expect(page.locator(".hand .card")).toHaveCount(26);
    peer.emit("leave_room", { roomId: code });
    await expect(page.locator(".results-page")).toBeVisible();
    await expect(page.getByText("Unranked result", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /Return to Menu/ }).click();
    const record = page.locator(".personal-stats .record-grid > div > strong");
    await expect(record).toHaveText(["1", "1", "100%", "0"]);
    await expect(page.locator(".personal-stats")).toContainText("Ranked: 0 wins / 0 games");
    await page.evaluate(() => localStorage.setItem("bluffx:stats", JSON.stringify({ games: 999, wins: 999 })));
    await page.reload();
    await expect(record).toHaveText(["1", "1", "100%", "0"]);
    await page.screenshot({ path: "tests/artifacts/record-casual-victory.png", fullPage: true });
  } finally { peer?.disconnect(); }
});

test("phone page restoration without bfcache and network recovery retain the exact saved seat", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await context.addInitScript(() => {
      sessionStorage.setItem("bluffx:guest", "true");
      localStorage.setItem("bluffx:profile", JSON.stringify({ name: "Phone Return", avatar: 0 }));
    });
    const page = await context.newPage();
    await page.goto("/");
    await page.getByRole("button", { name: "Play with AI", exact: true }).click();
    await page.getByRole("button", { name: "1", exact: true }).click();
    await page.getByRole("button", { name: "Create AI Table", exact: true }).click();
    await page.getByRole("button", { name: "Start Match", exact: true }).click();
    await expect(page.locator(".hand .card")).toHaveCount(26);
    const code = await page.locator(".room-code").innerText();
    const hand = await page.locator(".hand .card").evaluateAll(cards => cards.map(c => c.getAttribute("aria-label")));
    for (const mode of ["pageshow", "online"]) {
      await page.evaluate(async mode => {
        const { socket } = await import("/src/lib/socket.js");
        window.beforeSocketId = socket.id;
        if (mode === "pageshow") {
          window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));
          window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false }));
        } else { window.dispatchEvent(new Event("offline")); window.dispatchEvent(new Event("online")); }
      }, mode);
      await expect.poll(() => page.evaluate(async () => {
        const { socket } = await import("/src/lib/socket.js");
        return socket.connected && socket.gameReady && socket.id !== window.beforeSocketId;
      })).toBe(true);
      await expect(page.locator(".room-code")).toHaveText(code);
      expect(await page.locator(".hand .card").evaluateAll(cards => cards.map(c => c.getAttribute("aria-label")))).toEqual(hand);
    }
    const reconnectedAfterReplacement = await page.evaluate(async () => {
      const { socket } = await import("/src/lib/socket.js");
      socket.emitEvent(["seat_replaced", { message: "Seat recovered in another tab." }]);
      window.dispatchEvent(new Event("online"));
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false }));
      document.dispatchEvent(new Event("visibilitychange"));
      return socket.connected || socket.active;
    });
    expect(reconnectedAfterReplacement).toBe(false);
  } finally { await context.close(); }
});
