import { test, expect } from "@playwright/test";
test("visible side rail opens a player-code drawer, searches formatted codes and accepts requests", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const own = "0123456789abcdef",
    other = "1111222233334444",
    lookup = "aaaabbbbccccdddd";
  let accepted = false,
    outgoing = false;
  await page.route("**/auth/session", (r) =>
    r.fulfill({
      json: {
        user: {
          id: "social-side-user",
          name: "Alex",
          avatar: 0,
          emailVerified: true,
          tutorialStatus: "completed",
        },
      },
    }),
  );
  await page.route("**/auth/social/card", (r) =>
    r.fulfill({
      json: {
        handle: own,
        name: "Alex",
        incoming_requests: accepted ? 0 : 1,
        incoming_invites: 0,
      },
    }),
  );
  await page.route("**/auth/social", (r) =>
    r.fulfill({
      json: {
        profile: {
          handle: own,
          requests_enabled: true,
          invites_enabled: true,
          recent_enabled: true,
        },
        players: [
          {
            handle: other,
            name: "Robin",
            status: accepted ? "accepted" : "pending",
            incoming: true,
          },
          ...(outgoing
            ? [
                {
                  handle: lookup,
                  name: "Taylor",
                  status: "pending",
                  incoming: false,
                },
              ]
            : []),
        ],
        invites: [],
        blocks: [],
      },
    }),
  );
  await page.route("**/auth/social/search?*", (r) => {
    expect(new URL(r.request().url()).searchParams.get("handle")).toBe(lookup);
    return r.fulfill({
      json: { players: [{ handle: lookup, name: "Taylor" }] },
    });
  });
  await page.route("**/auth/social/action", (r) => {
    const d = r.request().postDataJSON();
    expect(d.handle).toBe(d.action === "accept" ? other : lookup);
    if (d.action === "accept") accepted = true;
    if (d.action === "request") outgoing = true;
    return r.fulfill({ json: { ok: true } });
  });
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (text) => {
          window.__copiedCode = text;
        },
      },
    }),
  );
  await page.goto("/");
  const rail = page.locator(".utility-rail");
  await expect(rail).toBeVisible();
  const bounds = await rail.boundingBox();
  expect(bounds.x).toBeGreaterThan(1340);
  await expect(
    page.getByRole("button", { name: "Copy your player code" }),
  ).toContainText("0123-4567-89AB-CDEF");
  await page
    .getByRole("button", { name: "Friends & Records", exact: true })
    .click();
  const drawer = page.locator(".social-drawer");
  await expect(drawer).toBeVisible();
  const box = await drawer.boundingBox();
  expect(Math.round(box.x + box.width)).toBe(1440);
  await expect(
    drawer.getByRole("heading", { name: "Alex", exact: true }),
  ).toBeVisible();
  await expect(drawer.getByLabel("Your player code")).toHaveText(
    "0123-4567-89AB-CDEF",
  );
  await drawer
    .getByRole("button", { name: "Copy Player Code", exact: true })
    .click();
  expect(await page.evaluate(() => window.__copiedCode)).toBe(
    "0123-4567-89AB-CDEF",
  );
  await drawer
    .getByLabel("Player Code", { exact: true })
    .fill("AAAA-BBBB-CCCC-DDDD");
  await drawer.getByRole("button", { name: "Search", exact: true }).click();
  await drawer
    .getByRole("button", { name: "Send request", exact: true })
    .click();
  await expect(
    drawer.getByRole("button", { name: "Request pending", exact: true }),
  ).toBeDisabled();
  await drawer.getByRole("button", { name: "Requests", exact: true }).click();
  await expect(
    drawer.getByText("Incoming request", { exact: true }),
  ).toBeVisible();
  await drawer.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(drawer.getByRole("status")).toHaveText(
    "Friend added to your circle.",
  );
  await drawer.getByRole("button", { name: "Friends", exact: true }).click();
  await expect(drawer.getByText("Friend", { exact: true })).toBeVisible();
  await page.screenshot({
    path: "tests/artifacts/friends-side-drawer.png",
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Friends & Records", exact: true }),
  ).toBeFocused();
});
test("mobile keeps social access above the page and guests see a sign-in explanation", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("bluffx:guest", "true"),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const button = page.getByRole("button", {
    name: "Friends & Records",
    exact: true,
  });
  await expect(button).toBeVisible();
  const box = await button.boundingBox();
  expect(box.y).toBeLessThan(180);
  await button.click();
  await expect(
    page.getByRole("button", { name: "Sign in to connect", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - innerWidth,
    ),
  ).toBeLessThanOrEqual(1);
});
