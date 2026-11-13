import { test, expect } from "@playwright/test";
import helper from "../../server/test/socket-client.cjs";
const { io } = helper;
const event = (s, name, check = () => true) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      s.off(name, fn);
      reject(Error(`Timeout ${name}`));
    }, 15000);
    function fn(data) {
      if (check(data)) {
        clearTimeout(timer);
        s.off(name, fn);
        resolve(data);
      }
    }
    s.on(name, fn);
  });
test("production UI and a guest's exact hand survive reload and closing/reopening a tab", async ({
  page,
  context,
}) => {
  await page.addInitScript(() => {
    sessionStorage.setItem("bluffx:guest", "true");
    localStorage.setItem(
      "bluffx:profile",
      JSON.stringify({ name: "Return Player", avatar: 0 }),
    );
  });
  await page.goto("/");
  await expect(page.locator(".release-banner")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(
    /beta|small glitches|development phase/i,
  );
  await page.getByRole("button", { name: "Play with AI", exact: true }).click();
  await page.getByRole("button", { name: "1", exact: true }).click();
  await page
    .getByRole("button", { name: "Create AI Table", exact: true })
    .click();
  await page.getByRole("button", { name: "Start Match", exact: true }).click();
  await expect(page.locator(".hand .card")).toHaveCount(26);
  const hand = await page
    .locator(".hand .card")
    .evaluateAll((cards) => cards.map((c) => c.getAttribute("aria-label")));
  const code = await page.locator(".room-code").innerText();
  await page.reload();
  await expect(page.locator(".hand .card")).toHaveCount(26);
  expect(
    await page
      .locator(".hand .card")
      .evaluateAll((cards) => cards.map((c) => c.getAttribute("aria-label"))),
  ).toEqual(hand);
  await page.close();
  const restored = await context.newPage();
  await restored.goto("/");
  await expect(restored.locator(".hand .card")).toHaveCount(26);
  expect(
    await restored
      .locator(".hand .card")
      .evaluateAll((cards) => cards.map((c) => c.getAttribute("aria-label"))),
  ).toEqual(hand);
  await expect(restored.locator(".room-code")).toHaveText(code);
});
test("the table announces grace and AI takeover, and returning restores player control", async ({
  page,
}) => {
  await page.addInitScript(() => {
    sessionStorage.setItem("bluffx:guest", "true");
    localStorage.setItem(
      "bluffx:profile",
      JSON.stringify({ name: "Online Host", avatar: 0 }),
    );
  });
  await page.goto("/");
  await page
    .locator("nav")
    .getByRole("button", { name: "Create Room", exact: true })
    .click();
  await page.getByRole("button", { name: "2", exact: true }).click();
  await page.locator(".start-button").click();
  const roomId = (await page.locator(".room-code").innerText()).trim();
  let guest, resumed;
  try {
    guest = io("http://localhost:4020", {
      autoConnect: false,
      transports: ["websocket"],
    });
    let waiting = event(guest, "connect");
    guest.connect();
    await waiting;
    waiting = event(guest, "seat_session");
    const state = event(guest, "room_state");
    guest.emit("join_room", { roomId, name: "Offline Peer" });
    const token = (await waiting).token;
    await state;
    waiting = event(guest, "room_state", (s) => s.you.ready);
    guest.emit("set_ready", { roomId, ready: true });
    await waiting;
    await page
      .getByRole("button", { name: "Start Match", exact: true })
      .click();
    await expect(page.locator(".hand .card")).toHaveCount(26);
    guest.disconnect();
    await expect(page.locator(".presence-banner")).toContainText(
      "Clock paused",
    );
    await expect(page.locator(".player-panel")).toContainText("Offline");
    await expect(
      page.getByRole("button", { name: /Play Face Down/ }),
    ).toBeDisabled();
    await expect(page.locator(".presence-banner")).toContainText(
      "AI is playing for Offline Peer",
      { timeout: 15000 },
    );
    await expect(page.locator(".player-panel")).toContainText("AI playing");
    resumed = io("http://localhost:4020", {
      autoConnect: false,
      transports: ["websocket"],
      auth: { resumeToken: token },
    });
    waiting = event(resumed, "room_state");
    resumed.connect();
    const restored = await waiting;
    expect(restored.you.aiTakeover).toBe(false);
    await expect(page.locator(".presence-banner")).toHaveCount(0);
    await expect(page.locator(".player-panel")).not.toContainText("AI playing");
    await page.screenshot({
      path: "tests/artifacts/reconnect-restored.png",
      fullPage: true,
    });
  } finally {
    guest?.disconnect();
    resumed?.disconnect();
  }
});
