// Turns a source image into a full-bleed phone wallpaper: fills the screen,
// smart-crops toward the subject (so the creature, not the white margin, is what
// you see), and flattens any transparency/letterbox onto near-black. This is
// what makes every day's horror look like an intentional wallpaper instead of
// "a picture pasted on my screen."

import sharp from 'sharp';

const DEFAULT_W = 1290; // iPhone 15 Pro portrait; iOS scales for other devices
const DEFAULT_H = 2796;
const BG = '#0d0b10'; // matches the app background

export function wallpaperSize() {
  const [w, h] = (process.env.CH_WALLPAPER_SIZE || `${DEFAULT_W}x${DEFAULT_H}`)
    .split('x')
    .map((n) => Number(n));
  return { width: w > 0 ? w : DEFAULT_W, height: h > 0 ? h : DEFAULT_H };
}

// CH_WALLPAPER_FIT: "cover" (default) fills the screen and smart-crops toward
// the subject; "contain" shows the whole image centered on a near-black canvas.
export function wallpaperFit() {
  return process.env.CH_WALLPAPER_FIT === 'contain' ? 'contain' : 'cover';
}

export async function renderWallpaper(sourceBuffer, size = wallpaperSize()) {
  const fit = wallpaperFit();
  const resize =
    fit === 'contain'
      ? { fit: 'contain', background: BG }
      : { fit: 'cover', position: sharp.strategy.attention };
  return sharp(sourceBuffer, { failOn: 'none' })
    .rotate() // honor EXIF orientation
    .resize(size.width, size.height, resize)
    .flatten({ background: BG })
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();
}

// Small bounded LRU cache so today's wallpaper is only rendered once.
const cache = new Map();
const MAX_CACHE = 32;

export async function renderWallpaperCached(cacheKey, sourceBuffer, size = wallpaperSize()) {
  const key = `${cacheKey}|${size.width}x${size.height}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit); // touch (most-recently-used)
    return hit;
  }
  const out = await renderWallpaper(sourceBuffer, size);
  cache.set(key, out);
  if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
  return out;
}
