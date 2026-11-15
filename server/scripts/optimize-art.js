// Deterministic format conversion; retain PNG source artwork for future edits.
const sharp = require("sharp");
const path = require("node:path");
const fs = require("node:fs");
const root = path.resolve(__dirname, "../../client/public/art");
(async () => {
  for (const [name, quality] of [
    ["lounge", 85],
    ["portraits", 90],
  ]) {
    const source = path.join(root, name + ".png"),
      target = path.join(root, name + ".webp");
    await sharp(source).webp({ quality, effort: 6 }).toFile(target);
    console.log(
      `${name}: ${fs.statSync(source).size} -> ${fs.statSync(target).size} bytes`,
    );
  }
})().catch(() => {
  console.error("Artwork optimization failed.");
  process.exitCode = 1;
});
