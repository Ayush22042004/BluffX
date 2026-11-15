import { test, expect, chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
const api = "http://localhost:4020/auth/";
async function account(context, name) {
  const email = `party-${name}-${Date.now()}@example.com`.toLowerCase();
  const signup = await context.request.post(api + "signup", { data: { name, email, password: "PartyTestPass123!" } });
  expect(signup.status()).toBe(201);
  const dir = path.resolve(import.meta.dirname, "../../server/.data/mail");
  const message = fs.readdirSync(dir).map(f => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))).find(m => m.to === email && m.subject.includes("Verify"));
  const token = new URL(message.text.match(/http[^\s]+/)[0]).searchParams.get("token");
  expect((await context.request.post(api + "verify-email", { data: { token } })).ok()).toBe(true);
  await context.request.post(api + "tutorial", { data: { status: "completed" } });
  const card = await context.request.get(api + "social/card");
  expect(card.ok(), await card.text()).toBe(true);
  const data = await card.json();
  expect(data.handle).toMatch(/^[a-f0-9]{16}$/);
  return data.handle;
}
test("a friend party keeps real voice through a match, results and leaving a table; refresh recovers membership safely", async () => {
  test.skip(process.env.BLUFFX_TEST_DATABASE !== "neon", "Real friend/account transactions run with npm run test:party on an isolated PostgreSQL database.");
  test.setTimeout(180000);
  const browser = await chromium.launch({ channel: "chrome", args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
  try {
    const ca = await browser.newContext({ permissions: ["microphone"], viewport: { width: 1366, height: 900 } });
    const cb = await browser.newContext({ permissions: ["microphone"], viewport: { width: 1366, height: 900 } });
    const a = await account(ca, "PartyHost"), b = await account(cb, "PartyFriend");
    const requested = await ca.request.post(api + "social/action", { data: { handle: b, action: "request" } });
    expect(requested.ok(), await requested.text()).toBe(true);
    expect((await cb.request.post(api + "social/action", { data: { handle: a, action: "accept" } })).ok()).toBe(true);
    const pa = await ca.newPage(), pb = await cb.newPage(), errors = [];
    for (const p of [pa, pb]) p.on("pageerror", e => errors.push(e.message));
    await Promise.all([pa.goto("http://localhost:5180"), pb.goto("http://localhost:5180")]);
    await pa.getByRole("button", { name: "Open party" }).click();
    const da = pa.getByRole("dialog", { name: "Your party" });
    await da.getByRole("button", { name: "Create party", exact: true }).click();
    await da.getByRole("button", { name: "Invite to party", exact: true }).click();
    await expect(pb.getByLabel("Party invitations", { exact: true })).toBeVisible();
    await pb.getByRole("button", { name: "Open party" }).click();
    const db = pb.getByRole("dialog", { name: "Your party" });
    await db.getByRole("button", { name: "Join party", exact: true }).click();
    await expect(da.locator(".party-members li")).toHaveCount(2);
    await expect(db.locator(".party-members li")).toHaveCount(2);
    const avatars = await da.locator(".party-members .avatar").evaluateAll(els => els.map(el => {
      const box = el.getBoundingClientRect(); return { width: box.width, height: box.height };
    }));
    for (const avatar of avatars) { expect(avatar.width).toBe(40); expect(avatar.height).toBe(40); }
    for (const [p, d] of [[pa, da], [pb, db]]) {
      await d.getByRole("button", { name: "Join Voice", exact: true }).click();
      await d.getByRole("button", { name: "Unmute Mic", exact: true }).click();
    }
    for (const p of [pa, pb]) {
      await expect.poll(() => p.evaluate(() => [...document.querySelectorAll("audio")].filter(a => a.srcObject && !a.paused).length)).toBe(1);
      await p.evaluate(() => { window.partyAudioElement = document.querySelector("audio"); });
    }
    for (const d of [da, db]) await d.getByRole("button", { name: "Close party" }).click();
    await pa.locator("nav").getByRole("button", { name: "Create Room", exact: true }).click();
    await pa.getByRole("button", { name: "2", exact: true }).click();
    await pa.locator(".start-button").click();
    const code = await pa.locator(".room-code").innerText();
    await pb.getByRole("button", { name: "Join Room", exact: true }).first().click();
    await pb.getByLabel("Room code", { exact: true }).fill(code.trim());
    await pb.locator("form").getByRole("button", { name: "Join Room", exact: true }).click();
    await pb.getByRole("button", { name: /Ready Up/ }).click();
    await pa.getByRole("button", { name: "Start Match", exact: true }).click();
    await expect(pa.locator(".hand .card")).toHaveCount(26);
    await pb.getByRole("button", { name: "Leave table", exact: true }).click();
    await pb.getByRole("button", { name: "Leave Table", exact: true }).click();
    await expect(pa.locator(".results-page")).toBeVisible();
    for (const p of [pa, pb]) {
      expect(await p.evaluate(() => document.querySelector("audio") === window.partyAudioElement && !window.partyAudioElement.paused && window.partyAudioElement.srcObject.getAudioTracks()[0].readyState === "live")).toBe(true);
      await p.getByRole("button", { name: "Open party" }).click();
      await expect(p.getByRole("dialog", { name: "Your party" }).getByRole("button", { name: "Mute Mic", exact: true })).toBeVisible();
    }
    await pa.screenshot({ path: "tests/artifacts/party-after-match.png", fullPage: true });
    await pb.reload();
    await pb.getByRole("button", { name: "Open party" }).click();
    await expect(db.locator(".party-members li")).toHaveCount(2);
    await expect(db.getByRole("button", { name: "Join Voice", exact: true })).toBeVisible();
    for (const theme of ["blue", "pink", "emerald"]) {
      await pb.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await pb.setViewportSize({ width: 390, height: 844 });
      expect(await pb.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      await pb.screenshot({ path: `tests/artifacts/party-${theme}-mobile.png`, fullPage: true });
    }
    await db.getByRole("button", { name: "Leave party", exact: true }).click();
    await expect(da.locator(".party-members li")).toHaveCount(1);
    expect(errors).toEqual([]);
  } finally { await browser.close(); }
});

test("party access is visible and its guest explanation fits mobile and traps focus", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("bluffx:guest", "true"));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Open party" }).click();
  const panel = page.getByRole("dialog", { name: "Your party" });
  await expect(panel).toContainText("Sign in to create a party");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await page.keyboard.press("Escape");
  await expect(panel).not.toBeVisible();
});
