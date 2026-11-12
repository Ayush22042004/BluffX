import { test, expect } from "@playwright/test";

test("new account is offered a tutorial, plays through it, and retains completion", async ({
  page,
}) => {
  const address = `tutorial-${Date.now()}@example.com`,
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Create Account", exact: true })
    .click();
  await page.getByLabel("Player name", { exact: true }).fill("New Bluffer");
  await page.getByLabel("Email address", { exact: true }).fill(address);
  await page.getByLabel("Password", { exact: true }).fill("TutorialPass123!");
  await page
    .getByLabel("Confirm password", { exact: true })
    .fill("TutorialPass123!");
  await page
    .locator("form")
    .getByRole("button", { name: "Create Account", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Welcome to BluffX", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "tests/artifacts/tutorial-invitation.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Start Tutorial Game", exact: true })
    .click();
  const tutorial = page.getByRole("dialog", {
    name: "Tutorial game",
    exact: true,
  });
  await expect(
    tutorial.getByRole("button", { name: "Play Face Down", exact: true }),
  ).toBeDisabled();
  // A wrong first card cannot complete the guided truthful-claim lesson.
  await tutorial.getByRole("button", { name: "4 ♠", exact: true }).click();
  await expect(
    tutorial.getByRole("button", { name: "Play Face Down", exact: true }),
  ).toBeDisabled();
  await tutorial.getByRole("button", { name: "4 ♠", exact: true }).click();
  await tutorial.getByRole("button", { name: "J ♥", exact: true }).click();
  await tutorial.getByRole("button", { name: "J ♣", exact: true }).click();
  await tutorial
    .getByRole("button", { name: "Claim a rank: Aces", exact: true })
    .click();
  await tutorial
    .getByRole("button", { name: "Claim Jacks", exact: true })
    .click();
  await page.screenshot({
    path: "tests/artifacts/tutorial-claim.png",
    fullPage: true,
  });
  await tutorial
    .getByRole("button", { name: "Play Face Down", exact: true })
    .click();
  await expect(
    tutorial.getByRole("heading", { name: "Your claim stands", exact: true }),
  ).toBeVisible();
  await tutorial
    .getByRole("button", { name: "Practice Calling Bluff", exact: true })
    .click();
  await tutorial
    .getByRole("button", { name: "Call Bluff", exact: true })
    .click();
  const challenge = page.getByRole("dialog", {
    name: "Practice bluff challenge",
    exact: true,
  });
  await challenge
    .getByRole("button", { name: "Inspect card 2", exact: true })
    .click();
  await challenge
    .getByRole("button", { name: /Call Bluff.*Reveal Cards/ })
    .click();
  await expect(
    tutorial.getByRole("heading", {
      name: "You caught the bluff!",
      exact: true,
    }),
  ).toBeVisible();
  await tutorial
    .getByRole("button", { name: "Practice Passing", exact: true })
    .click();
  await tutorial.getByRole("button", { name: "Pass", exact: true }).click();
  await tutorial.getByRole("button", { name: "4 ♠", exact: true }).click();
  await tutorial.getByRole("button", { name: "Q ♦", exact: true }).click();
  await tutorial
    .getByRole("button", { name: "Play Face Down", exact: true })
    .click();
  await expect(
    tutorial.getByRole("heading", { name: "One last test", exact: true }),
  ).toBeVisible();
  await tutorial
    .getByRole("button", { name: "Let the Table Respond", exact: true })
    .click();
  await expect(
    tutorial.getByRole("heading", {
      name: "Your poker face is ready",
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: "tests/artifacts/tutorial-finished.png",
    fullPage: true,
  });
  await tutorial
    .getByRole("button", { name: "Finish Tutorial", exact: true })
    .click();
  await expect(tutorial).toHaveCount(0);
  const account = await page.request.get("http://localhost:4020/auth/session");
  const accountUser = (await account.json()).user;
  expect(accountUser.tutorialStatus).toBe("completed");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: /Trust no one/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "Welcome to BluffX", exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      (id) => localStorage.getItem(`bluffx:stats:${id}`),
      accountUser.id,
    ),
  ).toBe(null);
  expect(errors).toEqual([]);
});

test("How to Play launches a replayable tutorial on mobile", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("bluffx:guest", "true"),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "How to Play", exact: true }).click();
  await page
    .getByRole("button", { name: "Play Tutorial Game", exact: true })
    .click();
  const tutorial = page.getByRole("dialog", {
    name: "Tutorial game",
    exact: true,
  });
  await expect(
    tutorial.getByRole("heading", {
      name: "Make your first claim",
      exact: true,
    }),
  ).toBeVisible();
  await tutorial.getByRole("button", { name: "J ♥", exact: true }).click();
  await tutorial.getByRole("button", { name: "J ♣", exact: true }).click();
  await tutorial
    .getByRole("button", { name: "Claim a rank: Aces", exact: true })
    .click();
  await tutorial
    .getByRole("button", { name: "Claim Jacks", exact: true })
    .click();
  await page.screenshot({
    path: "tests/artifacts/tutorial-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await tutorial
    .getByRole("button", { name: "Play Face Down", exact: true })
    .click();
  await tutorial
    .getByRole("button", { name: "Practice Calling Bluff", exact: true })
    .click();
  await tutorial
    .getByRole("button", { name: "Call Bluff", exact: true })
    .click();
  const challenge = page.getByRole("dialog", {
    name: "Practice bluff challenge",
    exact: true,
  });
  await challenge
    .getByRole("button", { name: "Inspect card 1", exact: true })
    .click();
  await challenge
    .getByRole("button", { name: /Call Bluff.*Reveal Cards/ })
    .click();
  await expect(
    tutorial.getByRole("heading", {
      name: "You caught the bluff!",
      exact: true,
    }),
  ).toBeVisible();
  await tutorial
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await expect(tutorial).toHaveCount(0);
  await page.getByRole("button", { name: "How to Play", exact: true }).click();
  await page
    .getByRole("button", { name: "Play Tutorial Game", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Make your first claim", exact: true }),
  ).toBeVisible();
});
