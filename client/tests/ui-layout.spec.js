import { test, expect } from "@playwright/test";

const sizes = [360, 390, 768, 1024, 1366, 1920];
async function inspect(page, label, width, strict = true) {
  const metrics = await page.evaluate(() => {
    const panels = [
      ...document.querySelectorAll(".panel, .modal, .auth-card"),
    ].filter((el) => el.getBoundingClientRect().height > 0);
    return {
      overflow: document.documentElement.scrollWidth - innerWidth,
      collisions: [
        ...document.querySelectorAll(".game-layout > .right"),
      ].flatMap((sidebar) => {
        const cards = [...sidebar.querySelectorAll(":scope > .panel")];
        const collisions = [];
        for (let i = 0; i < cards.length; i++)
          for (let j = i + 1; j < cards.length; j++) {
            const a = cards[i].getBoundingClientRect(),
              b = cards[j].getBoundingClientRect();
            if (
              a.left < b.right - 1 &&
              a.right > b.left + 1 &&
              a.top < b.bottom - 1 &&
              a.bottom > b.top + 1
            )
              collisions.push([cards[i].className, cards[j].className]);
          }
        return collisions;
      }),
      clipped: panels
        .filter(
          (el) =>
            getComputedStyle(el).overflowY === "hidden" &&
            el.scrollHeight > el.clientHeight + 3,
        )
        .map((el) => ({
          cls: el.className,
          height: el.clientHeight,
          content: el.scrollHeight,
        })),
      voice: [...document.querySelectorAll(".voice-panel")].map((el) => ({
        height: el.clientHeight,
        content: el.scrollHeight,
      })),
    };
  });
  console.log(JSON.stringify({ label, width, ...metrics }));
  if (strict) {
    expect(metrics.overflow, `${label} at ${width}px`).toBeLessThanOrEqual(1);
    expect(metrics.clipped).toEqual([]);
    expect(metrics.collisions).toEqual([]);
  }
  if ([390, 1366, 1920].includes(width))
    await page.screenshot({
      path: `tests/artifacts/ui-${label}-${width}.png`,
      fullPage: true,
    });
}

test("responsive menu, profile, setup, login and dialog layout audit", async ({
  page,
}) => {
  test.setTimeout(120000);
  page.setDefaultTimeout(10000);
  await page.addInitScript(() => {
    sessionStorage.setItem("bluffx:guest", "true");
    localStorage.setItem(
      "bluffx:profile",
      JSON.stringify({ name: "A VERY LONG PLAYER NAME", avatar: 0 }),
    );
  });
  for (const width of sizes) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await expect(
      page.getByRole("button", { name: "My Profile", exact: true }),
    ).toBeVisible();
    await inspect(page, "home", width);
    await page.getByRole("button", { name: "My Profile", exact: true }).click();
    await inspect(page, "profile", width);
    await page
      .getByRole("button", { name: "Create Room", exact: true })
      .first()
      .click();
    await inspect(page, "setup", width);
    await page
      .getByRole("button", { name: "Leaderboard", exact: true })
      .click();
    await inspect(page, "leaderboard", width);
    await page.keyboard.press("Escape");
    await page.goto("/");
    await page
      .getByRole("button", { name: "How to Play", exact: true })
      .click();
    await inspect(page, "instructions", width);
  }
});

test("signed-in profile settings keep their full form on phone, tablet and desktop", async ({
  page,
}) => {
  const result = await page.request.post("http://localhost:4020/auth/signup", {
    data: {
      email: `layout-${Date.now()}@example.com`,
      name: "Profile Layout",
      password: "LayoutProfilePass123!",
    },
  });
  expect(result.status()).toBe(201);
  await page.request.post("http://localhost:4020/auth/tutorial", {
    data: { status: "completed" },
  });
  for (const width of [390, 768, 1366]) {
    await page.setViewportSize({ width, height: 768 });
    await page.goto("/");
    await page.getByRole("button", { name: "My Profile", exact: true }).click();
    await inspect(page, "account", width);
  }
});

test("lobby and six-player game panels remain complete at every breakpoint", async ({
  page,
}) => {
  test.setTimeout(120000);
  page.setDefaultTimeout(10000);
  await page.addInitScript(() => {
    sessionStorage.setItem("bluffx:guest", "true");
    localStorage.setItem(
      "bluffx:profile",
      JSON.stringify({ name: "AYUSH SINGH", avatar: 0 }),
    );
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Play with AI", exact: true }).click();
  await page.getByRole("button", { name: "5", exact: true }).click();
  await page
    .getByRole("button", { name: "Create AI Table", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Start Match", exact: true }),
  ).toBeVisible();
  for (const width of sizes) {
    await page.setViewportSize({ width, height: 900 });
    await inspect(page, "lobby", width);
  }
  await page.getByRole("button", { name: "Start Match", exact: true }).click();
  await expect(page.locator(".hand .card")).toHaveCount(9);
  for (const width of sizes) {
    await page.setViewportSize({ width, height: 900 });
    await inspect(page, "game", width);
  }
});

test("production login stays inside the viewport without prerelease messaging", async ({
  page,
}) => {
  for (const width of sizes) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/");
    await expect(
      page
        .locator("form")
        .getByRole("button", { name: "Sign In", exact: true }),
    ).toBeVisible();
    await expect(page.locator("body")).not.toContainText(
      /beta|small glitches|development phase/i,
    );
    await inspect(page, "login", width);
  }
});
