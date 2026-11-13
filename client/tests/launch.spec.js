import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import helper from "../../server/test/socket-client.cjs";
test("feedback and privacy are usable without attaching private game state", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("bluffx:guest", "true"),
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: "Report a problem", exact: true })
    .click();
  await page
    .getByLabel("Problem description")
    .fill("The playtest needs a clear reconnect message.");
  const sent = page.waitForRequest(
    (request) =>
      request.url().endsWith("/auth/report") && request.method() === "POST",
  );
  await page.getByRole("button", { name: "Send report", exact: true }).click();
  const body = (await sent).postDataJSON();
  expect(body.hand).toBeUndefined();
  expect(body.resumeToken).toBeUndefined();
  await expect(page.getByRole("status")).toContainText("Report saved");
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByRole("button", { name: "Privacy", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Your privacy" }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText("does not record audio");
});
test("email-confirmed account deletion removes the profile and revokes the browser session", async ({
  page,
}) => {
  const email = `erase-browser-${Date.now()}@example.com`;
  expect(
    (
      await page.request.post("http://localhost:4020/auth/signup", {
        data: {
          name: "Erase Browser",
          email,
          password: "EraseBrowserPassword123!",
        },
      })
    ).status(),
  ).toBe(201);
  await page.request.post("http://localhost:4020/auth/tutorial", {
    data: { status: "completed" },
  });
  await page.goto("/");
  await page.getByRole("button", { name: "My Profile", exact: true }).click();
  await page
    .getByRole("button", { name: "Delete account", exact: true })
    .click();
  await expect(page.locator("body")).toContainText("Check your email");
  const folder = path.resolve(import.meta.dirname, "../../server/.data/mail");
  const mail = fs
    .readdirSync(folder)
    .map((file) => JSON.parse(fs.readFileSync(path.join(folder, file), "utf8")))
    .findLast((m) => m.to === email && m.subject.includes("deletion"));
  const link = new URL(mail.text.match(/http[^\s]+/)[0]);
  await page.goto("/" + link.search);
  await page
    .getByRole("button", { name: "Permanently delete my account", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "Your account has been removed",
  );
  expect(
    (await page.request.get("http://localhost:4020/auth/session")).ok(),
  ).toBe(true);
  expect(
    (
      await (
        await page.request.get("http://localhost:4020/auth/session")
      ).json()
    ).user,
  ).toBeNull();
  await page
    .getByRole("button", { name: "Return to sign in", exact: true })
    .click();
  await expect(
    page.locator("form").getByRole("button", { name: "Sign In", exact: true }),
  ).toBeVisible();
});
test("host removes a visitor through the authoritative moderation action", async ({
  page,
}) => {
  await page.addInitScript(() => {
    sessionStorage.setItem("bluffx:guest", "true");
    localStorage.setItem(
      "bluffx:profile",
      JSON.stringify({ name: "Moderator", avatar: 0 }),
    );
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Create Room", exact: true })
    .first()
    .click();
  await page
    .locator(".setup-panel")
    .getByRole("button", { name: "Create Room", exact: true })
    .click();
  await expect(page.locator(".room-code")).toBeVisible();
  const code = (await page.locator(".room-code").innerText()).trim();
  const visitor = helper.io("http://localhost:4020", {
    autoConnect: false,
    transports: ["websocket"],
    reconnection: false,
  });
  try {
    await new Promise((resolve) => {
      visitor.once("server_ready", resolve);
      visitor.connect();
    });
    await new Promise((resolve, reject) =>
      visitor.emit("join_room", { roomId: code, name: "Visitor" }, (reply) =>
        reply.ok ? resolve() : reject(Error(reply.code)),
      ),
    );
    await page
      .getByRole("button", { name: "Remove Visitor", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Remove player", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Players (1/4)", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Remove Visitor", exact: true }),
    ).toHaveCount(0);
  } finally {
    visitor.disconnect();
  }
});
test("automatic diagnostics redact error content and include only a fixed category", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("bluffx:guest", "true"),
  );
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "My Profile", exact: true }),
  ).toBeVisible();
  const request = page.waitForRequest(
    (r) => r.url().endsWith("/auth/report") && r.method() === "POST",
  );
  await page.evaluate(() =>
    window.dispatchEvent(
      new ErrorEvent("error", { message: "SECRET_PRIVATE_CARD_AND_TOKEN" }),
    ),
  );
  const data = (await request).postDataJSON();
  expect(data.codes).toEqual(["WINDOW_ERROR"]);
  expect(JSON.stringify(data)).not.toContain("SECRET_PRIVATE_CARD_AND_TOKEN");
});
