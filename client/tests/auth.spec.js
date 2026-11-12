import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
const outbox = path.resolve(import.meta.dirname, "../../server/.data/mail");
function emailToken(address, subject) {
  const messages = fs
    .readdirSync(outbox)
    .map((f) => JSON.parse(fs.readFileSync(path.join(outbox, f), "utf8")));
  const text = messages
    .filter((m) => m.to === address && m.subject.includes(subject))
    .at(-1)?.text;
  if (!text) throw Error("Expected a local email preview.");
  return new URL(text.match(/http[^\s]+/)[0]);
}
test("email signup, verification, profile persistence, signout, and login", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const address = `browser-${Date.now()}@example.com`;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Welcome back.", exact: true }),
  ).toBeVisible();
  const config = await (
    await page.request.get("http://localhost:4020/auth/config")
  ).json();
  if (config.googleClientId)
    await expect(page.locator(".google-widget")).toBeVisible();
  else
    await expect(
      page.getByRole("button", { name: /Continue with Google/ }),
    ).toBeDisabled();
  await page.screenshot({
    path: "tests/artifacts/login-desktop.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Create Account", exact: true })
    .click();
  await page.getByLabel("Player name", { exact: true }).fill("Account Player");
  await page.getByLabel("Email address", { exact: true }).fill(address);
  await page.getByLabel("Password", { exact: true }).fill("BrowserPass123!");
  await page
    .getByLabel("Confirm password", { exact: true })
    .fill("BrowserPass123!");
  await page
    .locator("form")
    .getByRole("button", { name: "Create Account", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: /You \(Account Player\)/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "Welcome to BluffX", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Skip for now", exact: true }).click();
  await page.getByRole("button", { name: "My Profile", exact: true }).click();
  await expect(page.getByText(address, { exact: true })).toBeVisible();
  await page
    .getByRole("textbox", { name: "Player name", exact: true })
    .fill("Saved Player");
  await page.getByRole("button", { name: "Avatar 4", exact: true }).click();
  await page.getByRole("button", { name: "Save Profile", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /You \(Saved Player\)/ }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: /You \(Saved Player\)/ }),
  ).toBeVisible();
  const verification = emailToken(address, "Verify");
  await page.goto(verification.href);
  await page
    .getByRole("button", { name: "Verify My Email", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "Your email is verified",
  );
  await page
    .getByRole("button", { name: "Back to sign in", exact: true })
    .click();
  await page.getByLabel("Email address", { exact: true }).fill(address);
  await page.getByLabel("Password", { exact: true }).fill("BrowserPass123!");
  await page
    .locator("form")
    .getByRole("button", { name: "Sign In", exact: true })
    .click();
  await page.getByRole("button", { name: "My Profile", exact: true }).click();
  await expect(page.getByText("Email verified", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Sign Out", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome back.", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Email address", { exact: true }).fill(address);
  await page.getByLabel("Password", { exact: true }).fill("WrongPassword123!");
  await page
    .locator("form")
    .getByRole("button", { name: "Sign In", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Email or password is incorrect",
  );
  await page
    .getByRole("button", { name: "Forgot password?", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Send Reset Link", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("reset instructions");
  const reset = emailToken(address, "Reset");
  await page.goto(reset.href);
  await page.getByLabel("Password", { exact: true }).fill("NewBrowserPass123!");
  await page
    .getByLabel("Confirm password", { exact: true })
    .fill("NewBrowserPass123!");
  await page
    .getByRole("button", { name: "Save New Password", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Password changed");
  await page
    .getByRole("button", { name: "Back to sign in", exact: true })
    .click();
  await page.getByLabel("Email address", { exact: true }).fill(address);
  await page.getByLabel("Password", { exact: true }).fill("NewBrowserPass123!");
  await page
    .locator("form")
    .getByRole("button", { name: "Sign In", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: /You \(Saved Player\)/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Play with AI", exact: true }).click();
  await page
    .getByRole("button", { name: "Create AI Table", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Pre-Game Lobby" }),
  ).toBeVisible();
  await expect(page.locator(".lobby-self")).toContainText("Saved Player");
  expect(errors).toEqual([]);
});

test("mobile login fits, password visibility works, and guest play remains available", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByLabel("Password", { exact: true }).fill("Visibility123!");
  await page
    .getByRole("button", { name: "Show password", exact: true })
    .click();
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute(
    "type",
    "text",
  );
  await page
    .getByRole("button", { name: "Hide password", exact: true })
    .click();
  await page.screenshot({
    path: "tests/artifacts/login-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.getByRole("button", { name: /Continue as guest/ }).click();
  await expect(
    page.getByRole("heading", { name: /Trust no one/ }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: /Trust no one/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "My Profile", exact: true }).click();
  await page
    .getByRole("button", { name: "Sign In / Create Account", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Welcome back.", exact: true }),
  ).toBeVisible();
});
