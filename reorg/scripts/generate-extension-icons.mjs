/**
 * Rasterizes public/logos/reorg-icon.svg (same as site favicon) into PNGs for the MV3 extension.
 * Run from repo root: node reorg/scripts/generate-extension-icons.mjs
 */
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const reorgRoot = join(__dirname, "..");
const svgPath = join(reorgRoot, "public", "logos", "reorg-icon.svg");
const outDir = join(reorgRoot, "chrome-extension", "icons");
mkdirSync(outDir, { recursive: true });

const svg = readFileSync(svgPath);
const sizes = [16, 32, 48, 128];

for (const size of sizes) {
  await sharp(svg).resize(size, size).png().toFile(join(outDir, `icon-${size}.png`));
}

console.log(`Wrote ${sizes.length} icons to ${outDir}`);
