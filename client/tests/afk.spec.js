import { test, expect } from "@playwright/test";
import helper from "../../server/test/socket-client.cjs";
const event = (socket, name) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Timeout " + name)), 10000);
    socket.once(name, (v) => {
      clearTimeout(timer);
      resolve(v);
    });
  });
test("real missed turns show both warnings, AI takeover and deliberate recovery without a new hand", async ({
  page,
}) => {
  test.setTimeout(120000);
  await page.addInitScript(() => {
    sessionStorage.setItem("bluffx:guest", "true");
    localStorage.setItem(
      "bluffx:profile",
      JSON.stringify({ name: "AFK Tester", avatar: 0 }),
    );
  });
  await page.goto("/");
  await page
    .locator("nav")
    .getByRole("button", { name: "Create Room", exact: true })
    .click();
  await page.getByRole("button", { name: "2", exact: true }).click();
  await page.getByRole("button", { name: "20", exact: true }).click();
  await page.locator(".start-button").click();
  const code = (await page.locator(".room-code").innerText()).trim();
  const peer = helper.io("http://localhost:4020", {
    autoConnect: false,
    transports: ["websocket"],
  });
  let active = true;
  const sent = new Set();
  try {
    let wait = event(peer, "connect");
    peer.connect();
    await wait;
    wait = event(peer, "room_state");
    peer.emit("join_room", { roomId: code, name: "Active Peer" });
    await wait;
    wait = event(peer, "room_state");
    peer.emit("set_ready", { ready: true });
    await wait;
    peer.on("room_state", (s) => {
      if (!active) return;
      const key = s.phase + ":" + s.roundId + ":" + s.turnSequence;
      if (sent.has(key)) return;
      if (
        s.phase === "playing" &&
        s.currentTurnId === s.you.id &&
        !s.lastMove
      ) {
        sent.add(key);
        peer.emit("play_cards", { cardIds: [s.hand[0].id], declaredRank: "J" });
      } else if (s.phase === "round_result" && s.hostId === s.you.id) {
        sent.add(key);
        peer.emit("continue_round", {});
      }
    });
    await page.evaluate(async () => {
      const { socket } = await import("/src/lib/socket.js");
      socket.on("room_state", (state) => (window.__afkState = state));
    });
    await page
      .getByRole("button", { name: "Start Match", exact: true })
      .click();
    await expect(page.locator(".toast")).toHaveText(
      "You missed your turn. Are you still playing?",
      { timeout: 25000 },
    );
    await expect(
      page.getByLabel("Possibly AFK", { exact: true }).first(),
    ).toBeVisible();
    await expect(page.locator(".toast")).toHaveText(
      "Final warning: Your next missed turn activates AI.",
      { timeout: 25000 },
    );
    await expect(
      page.getByLabel("Final Warning", { exact: true }).first(),
    ).toBeVisible();
    const control = page.getByRole("button", {
      name: "I’m Back — Take Control",
      exact: true,
    });
    await expect(control).toBeVisible({ timeout: 40000 });
    await expect(
      page.getByLabel("AI Playing", { exact: true }).first(),
    ).toBeVisible();
    const before = await page.evaluate(() => window.__afkState);
    await control.click();
    await expect(control).not.toBeVisible();
    await expect(page.locator(".toast")).toHaveText("You're back in control.");
    const after = await page.evaluate(() => window.__afkState);
    expect(after.you.aiTakeover).toBe(false);
    expect(after.you.afkStrikes).toBe(3);
    if (after.turnSequence === before.turnSequence) {
      expect(after.hand).toEqual(before.hand);
      expect(after.turnEndsAt).toBe(before.turnEndsAt);
    }
    await expect(page.locator(".your-seat")).toContainText("Your turn");
    await page
      .getByRole("button", { name: "Show all cards", exact: true })
      .click();
    await page.locator(".hand .card").first().click();
    await page.getByRole("button", { name: /Play Face Down/ }).click();
    await expect
      .poll(() => page.evaluate(() => window.__afkState?.you.afkStrikes))
      .toBe(0);
  } finally {
    active = false;
    peer.disconnect();
  }
});
