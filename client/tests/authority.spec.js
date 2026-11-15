import { test, expect, request } from "@playwright/test";
import helper from "../../server/test/socket-client.cjs";
import fs from "node:fs";
import path from "node:path";
async function verify(context, email) {
  const messages = fs
    .readdirSync(path.resolve(import.meta.dirname, "../../server/.data/mail"))
    .map((file) =>
      JSON.parse(
        fs.readFileSync(
          path.resolve(import.meta.dirname, "../../server/.data/mail", file),
          "utf8",
        ),
      ),
    );
  const message = messages.findLast(
    (m) => m.to === email && m.subject.includes("Verify"),
  );
  const token = new URL(message.text.match(/http[^\s]+/)[0]).searchParams.get(
    "token",
  );
  const result = await context.post("http://localhost:4020/auth/verify-email", {
    data: { token },
  });
  expect(result.ok()).toBe(true);
}
const { io } = helper;
const event = (s, name, predicate = () => true) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      s.off(name, fn);
      reject(Error("Timeout " + name));
    }, 10000);
    function fn(v) {
      if (predicate(v)) {
        clearTimeout(timer);
        s.off(name, fn);
        resolve(v);
      }
    }
    s.on(name, fn);
  });
test("ranked results come from the server, survive reload and ignore forged localStorage", async ({
  page,
}) => {
  const unique = Date.now(),
    password = "VerifiedTestPass123!";
  const signup = await page.request.post("http://localhost:4020/auth/signup", {
    data: {
      name: "Verified Winner",
      email: `official-${unique}@example.com`,
      password,
    },
  });
  expect(signup.status()).toBe(201);
  await verify(page.request, `official-${unique}@example.com`);
  const account = (await signup.json()).user;
  await page.request.post("http://localhost:4020/auth/tutorial", {
    data: { status: "completed" },
  });
  const other = await request.newContext();
  let peer;
  try {
    const joined = await other.post("http://localhost:4020/auth/signup", {
      data: {
        name: "Verified Peer",
        email: `official-peer-${unique}@example.com`,
        password,
      },
    });
    expect(joined.status()).toBe(201);
    await verify(other, `official-peer-${unique}@example.com`);
    const cookies = (await other.storageState()).cookies;
    const cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    await page.addInitScript((id) => {
      localStorage.setItem(
        "bluffx:stats",
        JSON.stringify({ games: 999999, wins: 999999 }),
      );
      localStorage.setItem(
        `bluffx:stats:${id}`,
        JSON.stringify({ games: 999999, wins: 999999 }),
      );
    }, account.id);
    await page.goto("/");
    await page
      .locator("nav")
      .getByRole("button", { name: "Create Room", exact: true })
      .click();
    await page.getByRole("button", { name: "2", exact: true }).click();
    await page.locator(".start-button").click();
    const code = (await page.locator(".room-code").innerText()).trim();
    peer = io("http://localhost:4020", {
      autoConnect: false,
      transports: ["websocket"],
      extraHeaders: { Cookie: cookie },
    });
    let wait = event(peer, "connect");
    peer.connect();
    await wait;
    wait = event(peer, "room_state");
    peer.emit("join_room", { roomId: code, name: "Spoofed" });
    expect((await wait).you.name).toBe("Verified Peer");
    wait = event(peer, "room_state", (s) => s.you.ready);
    peer.emit("set_ready", { roomId: code, ready: true });
    await wait;
    await page
      .getByRole("button", { name: "Start Match", exact: true })
      .click();
    await expect(page.locator(".hand .card")).toHaveCount(26);
    // A recovering match can finish while this notification is disconnected.
    // The authoritative finished snapshot must also refresh profile statistics.
    await page.evaluate(async () => {
      const { socket } = await import("/src/lib/socket.js");
      socket.removeAllListeners("stats_updated");
    });
    const refreshed = page.waitForResponse(
      (response) =>
        response.url().endsWith("/auth/stats") && response.status() === 200,
    );
    peer.emit("leave_room", { roomId: code });
    await expect(
      page.getByRole("heading", {
        name: "You (Verified Winner) Win!",
        exact: true,
      }),
    ).toBeVisible();
    expect((await (await refreshed).json()).stats.wins).toBe(1);
    await expect(
      page.getByText("Verified ranked result", { exact: true }),
    ).toBeVisible();
    let stats = (
      await (await page.request.get("http://localhost:4020/auth/stats")).json()
    ).stats;
    expect(stats.games).toBe(1);
    expect(stats.wins).toBe(1);
    await page.reload();
    await expect(
      page.getByRole("heading", {
        name: "You (Verified Winner) Win!",
        exact: true,
      }),
    ).toBeVisible();
    stats = (
      await (await page.request.get("http://localhost:4020/auth/stats")).json()
    ).stats;
    expect(stats.wins).toBe(1);
    await page.getByRole("button", { name: /Return to Menu/ }).click();
    await page
      .getByRole("button", { name: "Leaderboard", exact: true })
      .click();
    const row = page
      .locator(".score-row")
      .filter({ hasText: "Verified Winner" });
    await expect(row).toContainText("1 wins");
    await expect(row).not.toContainText("999999");
  } finally {
    peer?.disconnect();
    await other.dispose();
  }
});
