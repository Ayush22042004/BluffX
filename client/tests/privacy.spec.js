import { test, expect } from "@playwright/test";

test("public privacy policy is readable without login, JavaScript or a backend connection", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const backendRequests = [];
  page.on("request", request => { if (/\/auth\/|\/health|\/socket\.io/.test(request.url())) backendRequests.push(request.url()); });
  try {
    const response = await page.goto("/privacy/");
    expect(response.status()).toBe(200);
    await expect(page).toHaveTitle("Privacy Policy | BluffX");
    await expect(page.getByRole("heading", { name: "Privacy Policy", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "3. Google sign-in and Gmail API" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "7. Access, deletion and your choices" })).toBeVisible();
    await expect(page.getByRole("link", { name: "bluffxteam.noreply@gmail.com" }).first()).toHaveAttribute("href", "mailto:bluffxteam.noreply@gmail.com");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(backendRequests).toEqual([]);
    await page.screenshot({ path: "../server/.data/privacy-mobile.png" });
  } finally { await context.close(); }
});

test("login page links to the public privacy policy", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Privacy Policy", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Privacy Policy", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to BluffX" })).toHaveAttribute("href", "/");
});
