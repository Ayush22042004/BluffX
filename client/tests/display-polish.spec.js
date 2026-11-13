import { test, expect } from "@playwright/test";
test("desktop fullscreen recommendation returns after refresh; beta version sits beside the logo", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto("/");
  await expect(page.locator(".brand .beta-version")).toHaveText(
    /BETA.*v0\.3\.0/,
  );
  await expect(page.locator(".fullscreen-tip")).toBeVisible();
  await expect(page.locator(".fullscreen-tip kbd")).toHaveText(/F11|⌃ ⌘ F/);
  await page
    .getByRole("button", { name: "Dismiss fullscreen recommendation" })
    .click();
  await expect(page.locator(".fullscreen-tip")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".fullscreen-tip")).toBeVisible();
  await page
    .getByRole("button", { name: "Continue as guest", exact: false })
    .click();
  await expect(page.locator(".brand .beta-version")).toBeVisible();
});
test("mobile omits desktop key guidance; setup controls stay aligned and operable", async ({
  page,
}) => {
  await page.addInitScript(() => {
    sessionStorage.setItem("bluffx:guest", "true");
    localStorage.setItem(
      "bluffx:profile",
      JSON.stringify({ name: "UI Tester", avatar: 0 }),
    );
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.locator(".fullscreen-tip")).toHaveCount(0);
  await page
    .locator("nav")
    .getByRole("button", { name: "Create Room", exact: true })
    .click();
  const toggle = page.getByRole("checkbox", {
    name: /Allow optional voice chat/,
  });
  await toggle.uncheck();
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - innerWidth,
    ),
  ).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const boxes = await page
    .locator(".setup-fields .voice-toggle")
    .evaluate((el) => {
      const a = el.getBoundingClientRect(),
        b = el.querySelector("input").getBoundingClientRect();
      return {
        left: b.left >= a.left,
        right: b.right <= a.right,
        center: Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2),
      };
    });
  expect(boxes).toEqual({
    left: true,
    right: true,
    center: expect.any(Number),
  });
  expect(boxes.center).toBeLessThan(2);
  await page.screenshot({
    path: "tests/artifacts/setup-polished-desktop.png",
    fullPage: true,
  });
});
