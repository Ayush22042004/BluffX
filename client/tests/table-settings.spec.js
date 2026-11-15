import { test, expect } from "@playwright/test";

test("table settings fit all themes and save through the authoritative lobby", async ({
  page,
}) => {
  await page.addInitScript(() => {
    sessionStorage.setItem("bluffx:guest", "true");
    localStorage.setItem(
      "bluffx:profile",
      JSON.stringify({ name: "Settings Host", avatar: 0 }),
    );
  });
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto("/");
  await page
    .locator("nav")
    .getByRole("button", { name: "Create Room", exact: true })
    .click();
  await page.locator(".start-button").click();
  await expect(page.locator(".room-code")).toBeVisible();
  await page
    .getByRole("button", { name: "Table settings", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Table settings",
    exact: true,
  });
  for (const theme of ["blue", "pink", "emerald"]) {
    await page.evaluate(
      (theme) => (document.documentElement.dataset.theme = theme),
      theme,
    );
    for (const width of [360, 590, 1366]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(
        dialog.getByRole("button", { name: "Save table settings" }),
      ).toBeInViewport();
      const bounds = await dialog.evaluate((el) => {
        const box = el.getBoundingClientRect();
        return {
          overflow: el.scrollWidth - el.clientWidth,
          controlsFit: [...el.querySelectorAll("select")].every((s) => {
            const r = s.getBoundingClientRect();
            return r.left >= box.left && r.right <= box.right;
          }),
        };
      });
      expect(bounds.overflow).toBeLessThanOrEqual(1);
      expect(bounds.controlsFit).toBe(true);
      if (width !== 590)
        await page.screenshot({
          path: `tests/artifacts/table-settings-${theme}-${width}.png`,
          fullPage: true,
        });
    }
  }
  await dialog.getByLabel("Player capacity", { exact: true }).selectOption("6");
  await dialog.getByLabel("Card decks", { exact: true }).selectOption("2");
  await dialog.getByLabel("Turn duration", { exact: true }).selectOption("45");
  await dialog.getByRole("button", { name: "Save table settings" }).click();
  await expect(dialog).toHaveCount(0);
  await page
    .getByRole("button", { name: "Table settings", exact: true })
    .click();
  await expect(
    dialog.getByLabel("Player capacity", { exact: true }),
  ).toHaveValue("6");
  await expect(dialog.getByLabel("Card decks", { exact: true })).toHaveValue(
    "2",
  );
  await expect(dialog.getByLabel("Turn duration", { exact: true })).toHaveValue(
    "45",
  );
  await dialog.getByLabel("Player capacity", { exact: true }).selectOption("8");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("button", { name: "Table settings", exact: true })
    .click();
  await expect(
    dialog.getByLabel("Player capacity", { exact: true }),
  ).toHaveValue("6");
});

test("settings preserve a rejected draft, prevent duplicate saves, and trap keyboard focus", async ({
  page,
}) => {
  await page.addInitScript(() => {
    sessionStorage.setItem("bluffx:guest", "true");
    localStorage.setItem(
      "bluffx:profile",
      JSON.stringify({ name: "Reliable Host", avatar: 0 }),
    );
  });
  await page.goto("/");
  await page
    .locator("nav")
    .getByRole("button", { name: "Create Room", exact: true })
    .click();
  await page.locator(".start-button").click();
  const opener = page.getByRole("button", {
    name: "Table settings",
    exact: true,
  });
  await opener.click();
  const dialog = page.getByRole("dialog", {
    name: "Table settings",
    exact: true,
  });
  await expect(
    dialog.getByRole("button", { name: "Close dialog" }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    dialog.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    dialog.getByRole("button", { name: "Close dialog" }),
  ).toBeFocused();
  await dialog.getByLabel("Player capacity", { exact: true }).selectOption("6");
  await page.evaluate(async () => {
    const { socket } = await import("/src/lib/socket.js");
    window.__restoreTimeout = socket.timeout;
    window.__settingsAttempts = 0;
    socket.timeout = function (ms) {
      const emitter = window.__restoreTimeout.call(this, ms);
      return {
        emit: (event, payload, callback) => {
          if (event === "update_settings") {
            window.__settingsAttempts++;
            setTimeout(
              () =>
                callback(null, {
                  ok: false,
                  code: "STORAGE_UNAVAILABLE",
                  message: "Storage unavailable. Try again.",
                }),
              600,
            );
          } else emitter.emit(event, payload, callback);
        },
      };
    };
  });
  await dialog.getByRole("button", { name: "Save table settings" }).click();
  await expect(
    dialog.getByRole("button", { name: /Saving settings/ }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("alert")).toHaveText(
    "Storage unavailable. Try again.",
  );
  await expect(
    dialog.getByLabel("Player capacity", { exact: true }),
  ).toHaveValue("6");
  expect(await page.evaluate(() => window.__settingsAttempts)).toBe(1);
  await page.evaluate(async () => {
    const { socket } = await import("/src/lib/socket.js");
    socket.timeout = window.__restoreTimeout;
  });
  await dialog.getByRole("button", { name: "Save table settings" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  await opener.click();
  await expect(
    dialog.getByLabel("Player capacity", { exact: true }),
  ).toHaveValue("6");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});
