import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { renderWallpaper, renderWallpaperCached, wallpaperSize } from '../src/wallpaper.js';

const solid = (w, h, color) =>
  sharp({ create: { width: w, height: h, channels: 3, background: color } }).png().toBuffer();

test('renderWallpaper fills the exact phone size as JPEG (from a landscape source)', async () => {
  const src = await solid(1600, 900, { r: 255, g: 255, b: 255 });
  const out = await renderWallpaper(src, { width: 1290, height: 2796 });
  const meta = await sharp(out).metadata();
  assert.equal(meta.width, 1290);
  assert.equal(meta.height, 2796);
  assert.equal(meta.format, 'jpeg');
});

test('wallpaperSize honors CH_WALLPAPER_SIZE', () => {
  const prev = process.env.CH_WALLPAPER_SIZE;
  process.env.CH_WALLPAPER_SIZE = '1170x2532';
  assert.deepEqual(wallpaperSize(), { width: 1170, height: 2532 });
  if (prev === undefined) delete process.env.CH_WALLPAPER_SIZE;
  else process.env.CH_WALLPAPER_SIZE = prev;
});

test('renderWallpaperCached returns the same bytes on a repeat call', async () => {
  const src = await solid(800, 800, { r: 10, g: 10, b: 10 });
  const a = await renderWallpaperCached('key-x', src, { width: 600, height: 1300 });
  const b = await renderWallpaperCached('key-x', src, { width: 600, height: 1300 });
  assert.ok(Buffer.isBuffer(a));
  assert.equal(a, b); // cache hit → identical buffer reference
});
