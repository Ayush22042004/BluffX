import { test, expect } from "@playwright/test";
test.skip(
  process.env.BLUFFX_TEST_BUILD !== "true",
  "Explicit production-build qualification on isolated ports only.",
);

for (const blocked of [false, true]) {
  test(`production build uses same-origin auth and recovers its seat (${blocked ? "polling fallback" : "WebSocket upgrade"})`, async ({
    page,
  }) => {
    const wrongRequests = [];
    let upgraded = false;
    page.on("request", (request) => {
      if (/^http:\/\/localhost:(4000|4020)/.test(request.url()))
        wrongRequests.push(request.url());
    });
    if (blocked)
      await page.routeWebSocket("**/socket.io**", (ws) => ws.close());
    page.on("websocket", (ws) =>
      ws.on("framesent", (frame) => {
        if (frame.payload === "5") upgraded = true;
      }),
    );
    await page.goto("/");
    const version = await (await page.request.get("/version.json")).json();
    expect(version.version).toBe("0.3.0");
    if (process.env.VERCEL_GIT_COMMIT_SHA)
      expect(version.revision).toBe(process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 40));
    await page.getByRole("button", { name: /Continue as guest/ }).click();
    await page.getByRole("button", { name: "My Profile", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Player name" })
      .fill("Build Player");
    await page
      .getByRole("button", { name: "Save Profile", exact: true })
      .click();
    await page
      .locator("nav")
      .getByRole("button", { name: "Create Room", exact: true })
      .click();
    await page.locator(".start-button").click();
    const code = (await page.locator(".room-code").innerText()).trim();
    await page.reload();
    await expect(page.locator(".room-code")).toHaveText(code);
    await expect(page.locator(".player-panel .player-row")).toHaveCount(1);
    await expect(page.locator(".player-panel .player-row")).toContainText("You (Build Player)");
    await page
      .getByRole("button", { name: "Table settings", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Table settings",
      exact: true,
    });
    await dialog
      .getByLabel("Turn duration", { exact: true })
      .selectOption("45");
    await dialog.getByRole("button", { name: "Save table settings" }).click();
    await expect(dialog).toHaveCount(0);
    expect(wrongRequests).toEqual([]);
    if (!blocked) await expect.poll(() => upgraded).toBe(true);
    else expect(upgraded).toBe(false);
  });
}
