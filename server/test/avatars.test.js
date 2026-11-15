const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const sharp = require("sharp");
const { newDb } = require("pg-mem");
const { createAuth } = require("../src/auth");
const { encodeAvatar } = require("../src/avatars");
async function fixture() {
  const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg();
  const pool = new Pool();
  const auth = await createAuth({
    pool,
    production: false,
    allowedOrigins: new Set(["http://localhost:5173"]),
    mailer: { mode: "local", send: async () => {} },
  });
  const app = express();
  app.use("/auth", auth.router);
  const server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  const base = "http://127.0.0.1:" + server.address().port + "/auth/";
  const req = async (
    path,
    {
      body,
      cookie,
      method = "POST",
      type = "application/json",
      headers = {},
    } = {},
  ) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...headers,
        ...(body ? { "Content-Type": type } : {}),
        ...(cookie ? { cookie } : {}),
      },
      body: body
        ? type === "application/json"
          ? JSON.stringify(body)
          : body
        : undefined,
    });
    const binary = response.headers.get("content-type")?.includes("image/webp");
    return {
      status: response.status,
      body: binary
        ? Buffer.from(await response.arrayBuffer())
        : response.status === 304
          ? null
          : await response.json(),
      headers: response.headers,
      cookie: response.headers.get("set-cookie")?.split(";")[0],
    };
  };
  return {
    pool,
    req,
    close: async () => {
      await new Promise((r) => server.close(r));
      await auth.close();
      await pool.end();
    },
  };
}
const image = () =>
  sharp({
    create: { width: 40, height: 60, channels: 3, background: "#e92d88" },
  })
    .png()
    .toBuffer();
test("avatar encoding crops to 128px WebP, strips metadata and rejects dangerous or oversized input", async () => {
  const output = await encodeAvatar(await image()),
    meta = await sharp(output).metadata();
  assert.equal(meta.format, "webp");
  assert.equal(meta.width, 128);
  assert.equal(meta.height, 128);
  assert.equal(meta.exif, undefined);
  assert.ok(output.length <= 32768);
  for (const bad of [
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
    Buffer.from("not an image"),
    Buffer.alloc(524289),
  ])
    await assert.rejects(encodeAvatar(bad), { status: 400 });
  const huge = await sharp({
    create: { width: 1500, height: 1500, channels: 3, background: "#000" },
  })
    .png()
    .toBuffer();
  await assert.rejects(encodeAvatar(huge), { status: 400 });
});
test("guest upload is durable, cached as an immutable image, and replaces only its own prior upload", async () => {
  const f = await fixture();
  try {
    const photo = await image();
    const first = await f.req("avatar", { body: photo, type: "image/png" });
    assert.equal(first.status, 201);
    assert.ok(first.cookie.startsWith("bluffx_avatar_guest="));
    assert.ok(first.headers.get("set-cookie").includes("HttpOnly"));
    const view = await f.req("avatar/" + first.body.avatarId, {
      method: "GET",
    });
    assert.equal(view.status, 200);
    assert.equal(view.headers.get("content-type"), "image/webp");
    assert.match(view.headers.get("cache-control"), /immutable/);
    assert.equal((await sharp(view.body).metadata()).width, 128);
    assert.equal(
      (
        await f.req("avatar/" + first.body.avatarId, {
          method: "GET",
          headers: { "If-None-Match": view.headers.get("etag") },
        })
      ).status,
      304,
    );
    const next = await f.req("avatar", {
      body: photo,
      type: "image/png",
      cookie: first.cookie,
    });
    assert.equal(next.status, 201);
    assert.notEqual(next.body.avatarId, first.body.avatarId);
    assert.equal(
      (await f.req("avatar/" + first.body.avatarId, { method: "GET" })).status,
      404,
    );
    assert.equal(
      (await f.pool.query("SELECT COUNT(*) AS n FROM player_avatars")).rows[0]
        .n,
      1,
    );
    assert.equal(
      (
        await f.req("avatar", {
          body: Buffer.from("<svg/>"),
          type: "image/png",
          cookie: first.cookie,
        })
      ).status,
      400,
    );
  } finally {
    await f.close();
  }
});
test("account avatar survives sessions and cannot be assigned or removed by another account", async () => {
  const f = await fixture();
  try {
    const a = await f.req("signup", {
        body: {
          email: "photo-a@example.com",
          name: "A",
          password: "PhotoTestPass123!",
        },
      }),
      b = await f.req("signup", {
        body: {
          email: "photo-b@example.com",
          name: "B",
          password: "PhotoTestPass123!",
        },
      });
    const uploaded = await f.req("avatar", {
      body: await image(),
      type: "image/png",
      cookie: a.cookie,
    });
    assert.equal(uploaded.status, 201);
    const id = uploaded.body.avatarId;
    assert.equal(
      (await f.req("session", { method: "GET", cookie: a.cookie })).body.user
        .avatarId,
      id,
    );
    assert.equal(
      (
        await f.req("profile", {
          method: "PATCH",
          cookie: b.cookie,
          body: { name: "B", avatar: 0, avatarId: id },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await f.req("profile", {
          method: "PATCH",
          cookie: a.cookie,
          body: { name: "Photo A", avatar: 0, avatarId: id },
        })
      ).body.user.avatarId,
      id,
    );
    const login = await f.req("login", {
      body: { email: "photo-a@example.com", password: "PhotoTestPass123!" },
    });
    assert.equal(login.body.user.avatarId, id);
    const reset = await f.req("profile", {
      method: "PATCH",
      cookie: a.cookie,
      body: { name: "Photo A", avatar: 3, avatarId: null },
    });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.user.avatarId, null);
    assert.equal((await f.req("avatar/" + id, { method: "GET" })).status, 404);
  } finally {
    await f.close();
  }
});
