#!/usr/bin/env node
/**
 * Generate all app icons from assets/icon.png into public/.
 *
 * Outputs:
 *  - logo.png                 SignalK app icon (package.json signalk.appIcon)
 *  - favicon.ico              multi-size (16/32/48)
 *  - favicon-16x16.png, favicon-32x32.png
 *  - apple-touch-icon.png     180x180 for iOS home screen
 *  - icon-192.png, icon-512.png  PWA manifest icons, declared as
 *    "any maskable" — the source must be full-bleed with all important
 *    artwork inside the central circle of 80% diameter (the adaptive-icon
 *    safe zone) so Android's circle/squircle masks don't clip it.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = path.join(root, 'assets', 'icon.png');
const outDir = path.join(root, 'public');

const resize = (size) => sharp(source).resize(size, size, { fit: 'cover' }).png();

async function backgroundColor() {
  const { data } = await sharp(source)
    .extract({ left: 0, top: 0, width: 1, height: 1 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { r: data[0], g: data[1], b: data[2] };
}

async function main() {
  await mkdir(outDir, { recursive: true });

  const sizes = [
    ['logo.png', 512],
    ['favicon-16x16.png', 16],
    ['favicon-32x32.png', 32],
    ['apple-touch-icon.png', 180],
    ['icon-192.png', 192],
    ['icon-512.png', 512],
  ];
  for (const [file, size] of sizes) {
    await resize(size).toFile(path.join(outDir, file));
    console.log(`public/${file} (${size}x${size})`);
  }

  const icoSources = await Promise.all([16, 32, 48].map((size) => resize(size).toBuffer()));
  await writeFile(path.join(outDir, 'favicon.ico'), await pngToIco(icoSources));
  console.log('public/favicon.ico (16/32/48)');

  const { r, g, b } = await backgroundColor();
  const hex = `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
  console.log(`background/theme color: ${hex} (index.html theme-color + manifest)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
