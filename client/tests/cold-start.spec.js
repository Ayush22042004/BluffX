import { test, expect } from "@playwright/test";
test("initial server failure retries authentication, restores the account and never queues disconnected gameplay", async ({
  page,
}) => {
  const signup = await page.request.post("http://localhost:4020/auth/signup", {
    data: {
      name: "Cold Start",
      email: `cold-${Date.now()}@example.com`,
      password: "ColdStartTestPass123!",
    },
  });
  expect(signup.status()).toBe(201);
  await page.request.post("http://localhost:4020/auth/tutorial", {
    data: { status: "completed" },
  });
  let attempts = 0;
  await page.route("**/auth/session", (route) => {
    attempts++;
    return attempts === 1 ? route.abort("failed") : route.continue();
  });
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: /You \(Cold Start\)/ }),
  ).toBeVisible();
  expect(attempts).toBeGreaterThanOrEqual(2);
  const result = await page.evaluate(async () => {
    const { socket, sendGameAction } = await import("/src/lib/socket.js");
    socket.disconnect();
    const response = await sendGameAction("play_cards", {
      cardIds: ["stale"],
      declaredRank: "J",
    });
    const queued = socket.sendBuffer.length;
    socket.connect();
    return { response, queued };
  });
  expect(result.response.code).toBe("SERVER_RECOVERING");
  expect(result.queued).toBe(0);
});
