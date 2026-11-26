import { test, expect } from "@playwright/test";

test("maintenance is explicit, mobile friendly and automatically restores the app without clearing credentials", async ({ page }) => {
  let maintenance = true, checks = 0;
  await page.route("**/health", route => {
    checks++;
    return route.fulfill({ json: maintenance ? { ok: false, maintenance: true, code: "SERVER_MAINTENANCE" } : { ok: true, ready: true }, headers: { "Access-Control-Allow-Origin": "*" } });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "A quick break. A better table." })).toBeVisible();
  await expect(page.getByText("Scheduled maintenance", { exact: true })).toBeVisible();
  await expect(page.locator("[inert]")).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "../server/.data/maintenance-ui-mobile.png" });
  await page.evaluate(() => localStorage.setItem("maintenance-preserve-fixture", "saved"));
  const before = checks;
  maintenance = false;
  await page.getByRole("button", { name: "Check again", exact: true }).click();
  await expect(page.getByRole("heading", { name: "A quick break. A better table." })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Continue as guest" })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("maintenance-preserve-fixture"))).toBe("saved");
  expect(checks).toBeGreaterThan(before);
});

test("a network error is not mislabeled as maintenance; auth maintenance activates the notice", async ({ page }) => {
  await page.route("**/health", route => route.abort());
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Continue as guest" })).toBeVisible();
  await expect(page.getByText("Scheduled maintenance", { exact: true })).toHaveCount(0);
  await page.route("**/auth/session", route => route.fulfill({ status: 503, json: { maintenance: true, code: "SERVER_MAINTENANCE", message: "Updating" }, headers: { "Access-Control-Allow-Origin": "http://localhost:5180", "Access-Control-Allow-Credentials": "true" } }));
  await page.reload();
  await expect(page.getByRole("heading", { name: "A quick break. A better table." })).toBeVisible();
});

test("an existing tab detects maintenance after its game transport disconnects", async ({ page }) => {
  test.skip(process.env.BLUFFX_TEST_BUILD === "true", "Transport injection uses the development module; other maintenance cases also run against the production build.");
  let maintenance = false;
  await page.route("**/health", route => route.fulfill({ json: maintenance ? { maintenance: true } : { ok: true, ready: true }, headers: { "Access-Control-Allow-Origin": "*" } }));
  await page.goto("/");
  await page.getByRole("button", { name: "Continue as guest" }).click();
  await page.waitForTimeout(100);
  maintenance = true;
  // Advance the throttle clock without waiting ten real seconds.
  await page.clock.install();
  await page.clock.fastForward(11000);
  await page.evaluate(async () => {
    const { socket } = await import("/src/lib/socket.js");
    socket.emitEvent(["disconnect", "transport close"]);
  });
  await expect(page.getByRole("heading", { name: "A quick break. A better table." })).toBeVisible();
});

test("healthy visitors do not start recurring health polling", async ({ page }) => {
  let checks = 0;
  await page.route("**/health", route => {
    checks++;
    return route.fulfill({ json: { ok: true, ready: true }, headers: { "Access-Control-Allow-Origin": "*" } });
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Continue as guest" })).toBeVisible();
  expect(checks).toBeGreaterThan(0);
  const before = checks;
  await page.clock.install();
  await page.clock.fastForward(300000);
  expect(checks).toBe(before);
});
