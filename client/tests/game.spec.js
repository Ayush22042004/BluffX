import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("bluffx:guest", "true"),
  );
});

test("profile, configurable AI table, live card play, and return home", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByRole("button", { name: "My Profile", exact: true }).click();
  await page.getByRole("textbox", { name: "Player name" }).fill("Ace Tester");
  await page.getByRole("button", { name: "Avatar 3", exact: true }).click();
  await page.getByRole("button", { name: "Save Profile", exact: true }).click();
  await page.reload();
  await expect(
    page.getByRole("button", { name: /You \(Ace Tester\)/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Play with AI", exact: true }).click();
  await page.getByRole("button", { name: "1", exact: true }).click();
  await expect(
    page.getByText("1 AI opponent + you · 2 players total"),
  ).toBeVisible();
  await page.screenshot({
    path: "tests/artifacts/ai-setup.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Create AI Table", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Pre-Game Lobby" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Players (2/2)" }),
  ).toBeVisible();
  await page.screenshot({ path: "tests/artifacts/lobby.png", fullPage: true });
  await page.getByRole("button", { name: "Start Match", exact: true }).click();
  await expect(page.locator(".hand .card")).toHaveCount(26);
  await expect(page.locator(".your-seat")).toContainText("Ace Tester");
  await expect(
    page.getByRole("button", { name: /Play Face Down/ }),
  ).toBeDisabled();
  await page.locator(".hand .card").last().click();
  await page
    .getByRole("button", { name: "Claim a rank: Jacks", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Choose your claimed rank" }),
  ).toBeVisible();
  await expect(page.locator(".rank-options button")).toHaveCount(13);
  await page.screenshot({
    path: "tests/artifacts/rank-picker-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Claim Queens", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /Play Face Down/ }),
  ).toContainText("Claim 1 Queen");

  await expect(
    page.getByRole("button", { name: /Play Face Down/ }),
  ).toBeEnabled();
  // Large hands must remain centred and clear of the player / rank / action row.
  await expect
    .poll(async () =>
      page.locator(".hand").evaluate((hand) => {
        const area = hand.getBoundingClientRect();
        const cards = [...hand.querySelectorAll(".card")].map((card) =>
          card.getBoundingClientRect(),
        );
        return cards.every(
          (card) =>
            card.left >= area.left - 1 &&
            card.right <= area.right + 1 &&
            card.bottom <= area.bottom + 1,
        );
      }),
    )
    .toBe(true);
  const boxes = await page.evaluate(() => ({
    cards: [...document.querySelectorAll(".hand .card")].map((card) => {
      const r = card.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    }),
    playerTop: document.querySelector(".your-seat").getBoundingClientRect().top,
    rankTop: document.querySelector(".rank-control").getBoundingClientRect()
      .top,
    actionsTop: document.querySelector(".actions").getBoundingClientRect().top,
    pile: (() => {
      const r = document
        .querySelector(".pile .card-back")
        .getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    })(),
  }));
  expect(Math.max(...boxes.cards.map((card) => card.bottom))).toBeLessThan(
    Math.min(boxes.playerTop, boxes.rankTop, boxes.actionsTop),
  );
  expect(
    boxes.cards.some(
      (card) =>
        card.left < boxes.pile.right &&
        card.right > boxes.pile.left &&
        card.top < boxes.pile.bottom &&
        card.bottom > boxes.pile.top,
    ),
  ).toBe(false);
  await page.screenshot({ path: "tests/artifacts/game.png", fullPage: true });
  await page.getByRole("button", { name: /Play Face Down/ }).click();
  await expect(page.locator(".hand .card")).toHaveCount(25);
  await expect(
    page.getByRole("button", { name: "Table rank: Queens", exact: true }),
  ).toBeDisabled();

  await page.getByRole("button", { name: "Leave table", exact: true }).click();
  await page.getByRole("button", { name: "Leave Table", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: /Trust no one/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Ace Tester", exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("mobile home and profile fit viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.screenshot({
    path: "tests/artifacts/home-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.getByRole("button", { name: "My Profile", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "My Profile", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});

// Real two-player flow verifies both the round result and the final winner screen.
test("final claim ends the match, records the win, and supports rematch", async ({
  page,
}) => {
  const { io } = await import("socket.io-client");
  let guest;
  const waitFor = (s, name, predicate = () => true) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        s.off(name, fn);
        reject(Error("Timed out: " + name));
      }, 8000);
      function fn(v) {
        if (predicate(v)) {
          clearTimeout(t);
          s.off(name, fn);
          resolve(v);
        }
      }
      s.on(name, fn);
    });
  try {
    await page.setViewportSize({ width: 1672, height: 940 });
    await page.goto("/");
    await page.getByRole("button", { name: "My Profile", exact: true }).click();
    await page.getByRole("textbox", { name: "Player name" }).fill("Winner");
    await page
      .getByRole("button", { name: "Save Profile", exact: true })
      .click();
    await page.getByRole("button", { name: "Home", exact: true }).click();
    await page.screenshot({
      path: "tests/artifacts/home-desktop.png",
      fullPage: true,
    });
    await page
      .locator("nav")
      .getByRole("button", { name: "Create Room", exact: true })
      .click();
    await page.getByRole("button", { name: "2", exact: true }).click();
    await page.screenshot({
      path: "tests/artifacts/create-room.png",
      fullPage: true,
    });
    await page.locator(".start-button").click();
    await expect(
      page.getByRole("heading", { name: "Pre-Game Lobby" }),
    ).toBeVisible();
    const code = (await page.locator(".room-code").innerText()).trim();
    guest = io("http://localhost:4000", { transports: ["websocket"] });
    await waitFor(guest, "connect");
    let pending = waitFor(guest, "room_state");
    guest.emit("join_room", { roomId: code, name: "Guest", avatar: 1 });
    await pending;
    pending = waitFor(guest, "room_state", (s) => s.you.ready);
    guest.emit("set_ready", { roomId: code, ready: true });
    await pending;
    await page
      .getByRole("button", { name: "Start Match", exact: true })
      .click();
    await expect(page.locator(".hand .card")).toHaveCount(26);
    // Inspect a non-Jack claim, then use the result's Next Round control.
    await page
      .getByRole("button", { name: "Show all cards", exact: true })
      .click();
    const labels = await page
      .locator(".hand .card")
      .evaluateAll((cards) => cards.map((c) => c.getAttribute("aria-label")));
    await page
      .locator(".hand .card")
      .nth(labels.findIndex((label) => !label.startsWith("J ")))
      .click();
    pending = waitFor(guest, "room_state", (s) => !!s.lastMove);
    await page.getByRole("button", { name: /Play Face Down/ }).click();
    let live = await pending;
    guest.emit("call_bluff", {
      roomId: code,
      selectedIndexes: [0],
      claimTs: live.lastMove.ts,
    });
    await expect(
      page.getByRole("heading", { name: "Bluff Caught!", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: "tests/artifacts/round-result.png",
      fullPage: true,
    });
    pending = waitFor(guest, "room_state", (s) => s.phase === "playing");
    await page.getByRole("button", { name: "Next Round", exact: true }).click();
    live = await pending;
    guest.emit("play_cards", {
      roomId: code,
      cardIds: [live.hand[0].id],
      declaredRank: "J",
    });
    await expect(page.locator(".your-seat")).toContainText("Your turn");
    await page
      .locator(".hand .card")
      .evaluateAll((cards) => cards.forEach((card) => card.click()));
    pending = waitFor(guest, "room_state", (s) => !!s.pendingWinnerId);
    await page.getByRole("button", { name: /Play Face Down/ }).click();
    await pending;
    await expect(page.locator(".hand .card")).toHaveCount(0);
    await expect(
      page.getByText("Final claim — pass or challenge to decide the winner."),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Play Face Down/ }),
    ).toBeDisabled();
    guest.emit("pass_bluff", { roomId: code });
    await expect(
      page.getByRole("heading", { name: "You (Winner) Win!", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: "tests/artifacts/winner.png",
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => JSON.parse(localStorage.getItem("bluffx:stats")).wins,
      ),
    ).toBe(1);
    await page.getByRole("button", { name: /Rematch/ }).click();
    await expect(page.locator(".hand .card")).toHaveCount(26);
  } finally {
    guest?.disconnect();
  }
});

test("six-player AI table remains usable on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "My Profile", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Player name" })
    .fill("Mobile Player");
  await page.getByRole("button", { name: "Save Profile", exact: true }).click();
  await page.getByRole("button", { name: "Play with AI", exact: true }).click();
  await page.getByRole("button", { name: "5", exact: true }).click();
  await page
    .getByRole("button", { name: "Create AI Table", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Players (6/6)" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Start Match", exact: true }).click();
  await expect(page.locator(".hand .card")).toHaveCount(9);
  await expect
    .poll(async () =>
      page.locator(".hand").evaluate((hand) => {
        const area = hand.getBoundingClientRect();
        return [...hand.querySelectorAll(".card")].every((card) => {
          const box = card.getBoundingClientRect();
          return (
            box.left >= area.left - 1 &&
            box.right <= area.right + 1 &&
            box.bottom <= area.bottom + 1
          );
        });
      }),
    )
    .toBe(true);
  await page.screenshot({
    path: "tests/artifacts/cards-mobile-fan.png",
    fullPage: true,
  });

  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page
    .getByRole("button", { name: "Show all cards", exact: true })
    .click();
  await page.locator(".hand .card").first().click();
  await expect(
    page.getByRole("button", { name: /Play Face Down/ }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Claim a rank: Jacks", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Claim Jacks", exact: true })
    .press("ArrowRight");
  await expect(
    page.getByRole("button", { name: "Claim Queens", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Claim a rank: Jacks", exact: true }),
  ).toBeFocused();
  await page
    .getByRole("button", { name: "Claim a rank: Jacks", exact: true })
    .click();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: "tests/artifacts/game-mobile.png",
    animations: "disabled",
    fullPage: true,
  });
});
