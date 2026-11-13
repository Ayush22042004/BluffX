const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const root = path.resolve(__dirname, "../..");
const { execFileSync } = require("node:child_process");
const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: root, encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);
for (const file of files) {
  if (
    /(^|\/)\.env(?:$|\.(?!example$))/i.test(file) ||
    /(^|\/)\.neon$|server\/\.data\//.test(file)
  )
    throw Error("Private configuration must not enter the release: " + file);
  if (
    !/\.(?:js|jsx|json|md|ya?ml|sql)$/.test(file) ||
    /(?:^|\/)tests?\//.test(file) ||
    !fs.existsSync(path.join(root, file))
  )
    continue;
  const text = fs.readFileSync(path.join(root, file), "utf8");
  if (/re_[a-zA-Z0-9]{30,}/.test(text))
    throw Error("Potential provider secret in release source: " + file);
}
const required = [
  "server/src/recovery.js",
  "server/src/room-service.js",
  "server/src/game-store.js",
  "server/src/voice.js",
  "client/src/VoiceChat.jsx",
  "server/migrations/004_launch_controls.sql",
];
for (const file of required)
  if (!fs.existsSync(path.join(root, file)))
    throw Error("Missing release file: " + file);
const versions = [
  "package.json",
  "client/package.json",
  "server/package.json",
].map((file) => JSON.parse(fs.readFileSync(path.join(root, file))).version);
if (new Set(versions).size !== 1) throw Error("Package versions disagree");
for (const name of fs
  .readdirSync(path.join(root, "server/migrations"))
  .filter((f) => f.endsWith(".sql"))) {
  const sql = fs.readFileSync(
    path.join(root, "server/migrations", name),
    "utf8",
  );
  if (sql.includes("\r")) throw Error("Migration must use LF: " + name);
  if (/\b(DROP|TRUNCATE)\s+(TABLE|SCHEMA|DATABASE)\b/i.test(sql))
    throw Error("Destructive migration needs separate review: " + name);
  console.log(
    "Migration",
    name,
    crypto.createHash("sha256").update(sql).digest("hex").slice(0, 12),
  );
}
console.log(
  "Release source and additive migration checks passed:",
  versions[0],
);
