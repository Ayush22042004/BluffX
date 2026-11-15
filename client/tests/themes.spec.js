import { test, expect } from "@playwright/test";

test("three themes apply immediately and persist across refresh and login", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("bluffx:guest", "true"));
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "Preferences", exact: true }).click();
  await expect(page.getByRole("radio")).toHaveCount(3);
  const colors = [];
  for (const [name, id] of [["Neon Pink", "pink"], ["Neon Emerald", "emerald"], ["Neon Blue", "blue"]]) {
    await page.getByRole("radio", { name: new RegExp(name) }).check();
    await expect(page.locator("html")).toHaveAttribute("data-theme", id);
    colors.push(await page.locator("header").evaluate(el => getComputedStyle(el).backgroundImage));
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", id);
    const palette = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return ["base", "primary", "secondary", "highlight"].map(role => style.getPropertyValue(`--palette-${role}`).trim());
    });
    expect(new Set(palette).size).toBe(4);
    await page.screenshot({ path: `tests/artifacts/palette-${id}-desktop.png`, fullPage: true });
    await page.getByRole("button", { name: "Preferences", exact: true }).click();
    await expect(page.getByRole("radio", { name: new RegExp(name) })).toBeChecked();
  }
  expect(new Set(colors).size).toBe(3);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("radio", { name: /Neon Emerald/ }).check();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: "tests/artifacts/theme-picker-mobile.png", fullPage: true });
  await page.evaluate(() => sessionStorage.removeItem("bluffx:guest"));
  await page.unrouteAll();
  // Remove the guest initializer for a fresh sign-in page using a second page in this browser.
  const login = await page.context().newPage();
  await login.goto("/");
  await expect(login.locator("html")).toHaveAttribute("data-theme", "emerald");
  await login.close();
});

test("invalid saved theme falls back to blue without losing reduced motion", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("bluffx:preferences:v1", JSON.stringify({ theme: "invalid", reduceMotion: true })));
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "blue");
  await expect(page.locator("html")).toHaveAttribute("data-reduce-motion", "true");
});
