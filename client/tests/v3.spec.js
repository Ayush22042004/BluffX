import { test, expect } from "@playwright/test";
test("ten-player dual-deck lobby, explicit one-deck override and mobile seats remain usable", async ({
  page,
}) => {
  const { io } = await import("../../server/test/socket-client.cjs");
  const guests = [];
  const wait = (s, p) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        s.off("room_state", fn);
        reject(Error("Room state timeout"));
      }, 10000);
      const fn = (x) => {
        if (p(x)) {
          clearTimeout(t);
          s.off("room_state", fn);
          resolve(x);
        }
      };
      s.on("room_state", fn);
    });
  await page.addInitScript(() => {
    sessionStorage.setItem("bluffx:guest", "true");
    localStorage.setItem(
      "bluffx:profile",
      JSON.stringify({ name: "Ten Host", avatar: 0 }),
    );
  });
  try {
    await page.goto("/");
    await page
      .locator("nav")
      .getByRole("button", { name: "Create Room", exact: true })
      .click();
    await page
      .getByLabel("Match preset", { exact: true })
      .selectOption("party");
    await expect(
      page.getByRole("button", { name: "Two decks", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "One deck", exact: true }).click();
    await page.getByRole("button", { name: "10", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "One deck", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Two decks", exact: true }).click();
    await page.locator(".start-button").click();
    await expect(page.locator(".room-code")).toBeVisible();
    const roomId = (await page.locator(".room-code").innerText()).trim();
    for (let i = 1; i < 10; i++) {
      const s = io("http://localhost:4020", { transports: ["websocket"] });
      guests.push(s);
      await new Promise((r) => s.on("connect", r));
      let p = wait(s, (x) => !!x.you);
      s.emit("join_room", { roomId, name: `Human ${i}`, avatar: i % 6 });
      await p;
      p = wait(s, (x) => x.you.ready);
      s.emit("set_ready", { roomId, ready: true });
      await p;
    }
    await expect(page.locator(".clockwise-seat")).toHaveCount(9);
    for (const width of [390, 1366]) {
      await page.setViewportSize({ width, height: 940 });
      await expect(
        page.getByRole("button", { name: "Start Match", exact: true }),
      ).toBeEnabled();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - innerWidth,
        ),
      ).toBeLessThanOrEqual(1);
      const collisions = await page
        .locator(".clockwise-seat")
        .evaluateAll((els) => {
          const r = els.map((e) => e.getBoundingClientRect());
          let n = 0;
          for (let i = 0; i < r.length; i++)
            for (let j = i + 1; j < r.length; j++)
              if (
                r[i].left < r[j].right - 1 &&
                r[i].right > r[j].left + 1 &&
                r[i].top < r[j].bottom - 1 &&
                r[i].bottom > r[j].top + 1
              )
                n++;
          return n;
        });
      expect(collisions).toBe(0);
    }
    await page
      .getByRole("button", { name: "Start Match", exact: true })
      .click();
    await expect(page.locator(".hand .card")).toHaveCount(11);
    await expect(page.locator(".clockwise-seat")).toHaveCount(9);
  } finally {
    guests.forEach((s) => s.disconnect());
  }
});
test("invitation URL opens the normal join form and reduced motion persists without a beta banner", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("bluffx:guest", "true"),
  );
  await page.goto("/?room=ABC123");
  await expect(
    page.getByRole("textbox", { name: "Room code", exact: true }),
  ).toHaveValue("ABC123");
  await page.getByRole("button", { name: "Preferences", exact: true }).click();
  await page.getByRole("checkbox", { name: "Reduce motion" }).check();
  await expect(page.locator("html")).toHaveAttribute(
    "data-reduce-motion",
    "true",
  );
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute(
    "data-reduce-motion",
    "true",
  );
  await expect(
    page.getByText("BluffX is in beta.", { exact: false }),
  ).toHaveCount(0);
});
test("Friends & Records switches safely between social, history, achievements and season views", async ({
  page,
}) => {
  await page.route("**/auth/social", (route) =>
    route.fulfill({
      json: {
        profile: {
          handle: "0123456789abcdef",
          requests_enabled: true,
          invites_enabled: true,
          recent_enabled: true,
        },
        players: [],
        invites: [],
        blocks: [],
      },
    }),
  );
  await page.route("**/auth/history?*", (route) =>
    route.fulfill({ json: { items: [], page: 0, hasMore: false } }),
  );
  await page.route("**/auth/achievements?*", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            achievement: "first_victory",
            title: "First Victory",
            unlocked_at: Date.now(),
          },
        ],
        hasMore: false,
      },
    }),
  );
  await page.route("**/auth/season?*", (route) =>
    route.fulfill({
      json: { items: [], season: { id: "2026-Q4" }, hasMore: false },
    }),
  );
  await page.route("**/auth/social/recent", (route) =>
    route.fulfill({ json: { players: [] } }),
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: "Create Account", exact: true })
    .click();
  await page.getByLabel("Player name", { exact: true }).fill("Social UI");
  await page
    .getByLabel("Email address", { exact: true })
    .fill(`social-ui-${Date.now()}@example.com`);
  await page
    .getByLabel("Password", { exact: true })
    .fill("social-test-password");
  await page
    .getByLabel("Confirm password", { exact: true })
    .fill("social-test-password");
  await page
    .locator("form")
    .getByRole("button", { name: "Create Account", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Skip for now", exact: true }),
  ).toBeVisible();
  const skip = page.getByRole("button", { name: "Skip for now", exact: true });
  if (await skip.isVisible()) await skip.click();
  await page
    .getByRole("button", { name: "Friends & Records", exact: true })
    .click();
  await expect(
    page.getByText("0123456789abcdef", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Match history", exact: true })
    .click();
  await expect(
    page.getByText("Completed account matches will appear here."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Achievements", exact: true }).click();
  await expect(page.getByText("First Victory", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Season", exact: true }).click();
  await expect(page.getByRole("heading", { name: "2026-Q4" })).toBeVisible();
  await page
    .getByRole("button", { name: "Recent players", exact: true })
    .click();
  await expect(page.getByText("No recent players to show.")).toBeVisible();
});
