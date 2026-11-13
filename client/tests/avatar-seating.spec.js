import { test, expect } from "@playwright/test";
import { createRequire } from "node:module";
import helper from "../../server/test/socket-client.cjs";
const require = createRequire(import.meta.url),
  sharp = require("../../server/node_modules/sharp");
const image = () =>
  sharp({
    create: { width: 48, height: 80, channels: 3, background: "#cf2d88" },
  })
    .png()
    .toBuffer();
const event = (s, name) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(Error("Timeout " + name)), 10000);
    s.once(name, (v) => {
      clearTimeout(t);
      resolve(v);
    });
  });
test("account uploads its own avatar, keeps it after reload, and shows numbered clockwise AI seats", async ({
  page,
}) => {
  const signup = await page.request.post("http://localhost:4020/auth/signup", {
    data: {
      email: `photo-${Date.now()}@example.com`,
      name: "Photo Player",
      password: "PhotoPlayerPass123!",
    },
  });
  expect(signup.status()).toBe(201);
  await page.request.post("http://localhost:4020/auth/tutorial", {
    data: { status: "completed" },
  });
  await page.goto("/");
  await page.getByRole("button", { name: "My Profile", exact: true }).click();
  await page
    .getByLabel("Upload avatar photo")
    .setInputFiles({
      name: "my-photo.png",
      mimeType: "image/png",
      buffer: await image(),
    });
  await expect(
    page.locator(".profile-editor .custom-avatar-image"),
  ).toHaveAttribute("src", /^data:image\//);
  await page.getByRole("button", { name: "Save Profile", exact: true }).click();
  const photo = page.locator(".profile-editor .custom-avatar-image");
  await expect(photo).toHaveAttribute("src", /\/auth\/avatar\/[a-f0-9-]+$/);
  const url = await photo.getAttribute("src");
  await page.reload();
  await page.getByRole("button", { name: "My Profile", exact: true }).click();
  await expect(photo).toHaveAttribute("src", url);
  await expect.poll(() => photo.evaluate((img) => img.naturalWidth)).toBe(128);
  await page.getByRole("button", { name: "Play with AI", exact: true }).click();
  await page.getByRole("button", { name: "5", exact: true }).click();
  await page
    .getByRole("button", { name: "Create AI Table", exact: true })
    .click();
  await expect(page.locator(".clockwise-seat")).toHaveCount(5);
  for (let i = 1; i <= 5; i++)
    await expect(
      page.getByRole("group", { name: `Seat ${i + 1}: Bot ${i}`, exact: true }),
    ).toBeVisible();
  const boxes = await page.locator(".clockwise-seat").evaluateAll((seats) =>
    seats.map((el) => {
      const r = el.getBoundingClientRect();
      return {
        seat: Number(el.dataset.seatNumber),
        x: r.x + r.width / 2,
        y: r.y + r.height / 2,
      };
    }),
  );
  expect(boxes.map((p) => p.seat)).toEqual([2, 3, 4, 5, 6]);
  expect(boxes[0].x).toBeLessThan(boxes[2].x);
  expect(boxes[2].x).toBeLessThan(boxes[4].x);
  expect(boxes[0].y).toBeGreaterThan(boxes[1].y);
  expect(boxes[4].y).toBeGreaterThan(boxes[3].y);
  await page.getByRole("button", { name: "Start Match", exact: true }).click();
  await expect(page.locator(".hand .card")).toHaveCount(9);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(390);
  await page.screenshot({
    path: "tests/artifacts/clockwise-six-mobile.png",
    fullPage: true,
  });
});
test("guest photo stays after reload and can be replaced with a built-in avatar", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("bluffx:guest", "true"),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "My Profile", exact: true }).click();
  await page.getByRole("textbox", { name: "Player name" }).fill("Guest Photo");
  await page
    .getByLabel("Upload avatar photo")
    .setInputFiles({
      name: "guest.png",
      mimeType: "image/png",
      buffer: await image(),
    });
  await page.getByRole("button", { name: "Save Profile", exact: true }).click();
  await expect(
    page.locator(".profile-editor .custom-avatar-image"),
  ).toHaveAttribute("src", /\/auth\/avatar\//);
  await page.reload();
  await expect(
    page.locator(".profile-summary .custom-avatar-image"),
  ).toBeVisible();
  await page.getByRole("button", { name: "My Profile", exact: true }).click();
  await page.getByRole("button", { name: "Avatar 2", exact: true }).click();
  await page.getByRole("button", { name: "Save Profile", exact: true }).click();
  await expect(
    page.locator(".profile-editor .custom-avatar-image"),
  ).toHaveCount(0);
});
test("a non-host sees the next authoritative seat on the left, then top, then right", async ({
  page,
}) => {
  const sockets = [];
  try {
    for (let i = 0; i < 3; i++) {
      const s = helper.io("http://localhost:4020", {
        autoConnect: false,
        transports: ["websocket"],
      });
      sockets.push(s);
      let wait = event(s, "connect");
      s.connect();
      await wait;
      wait = event(s, "room_state");
      if (!i) s.emit("create_room", { name: "Seat One", maxPlayers: 4 });
      else
        s.emit("join_room", {
          name: "Seat " + (i + 1),
          roomId: sockets[0].code,
        });
      const state = await wait;
      if (!i) sockets[0].code = state.roomId;
    }
    await page.addInitScript(() => {
      sessionStorage.setItem("bluffx:guest", "true");
      localStorage.setItem(
        "bluffx:profile",
        JSON.stringify({ name: "Seat Four", avatar: 0 }),
      );
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Join Room", exact: true }).click();
    await page.getByLabel("Room code", { exact: true }).fill(sockets[0].code);
    await page
      .locator(".join-page form")
      .getByRole("button", { name: "Join Room", exact: true })
      .click();
    await expect(page.locator(".clockwise-seat")).toHaveCount(3);
    const positions = await page
      .locator(".clockwise-seat")
      .evaluateAll((seats) =>
        seats.map((el) => ({
          seat: Number(el.dataset.seatNumber),
          x: el.getBoundingClientRect().x,
          y: el.getBoundingClientRect().y,
        })),
      );
    expect(positions.map((p) => p.seat)).toEqual([1, 2, 3]);
    expect(positions[0].x).toBeLessThan(positions[1].x);
    expect(positions[1].x).toBeLessThan(positions[2].x);
    expect(positions[1].y).toBeLessThan(positions[0].y);
  } finally {
    for (const s of sockets) s.disconnect();
  }
});
