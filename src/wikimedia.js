// Pulls candidate images from Wikimedia Commons categories.
//
// These categories are deliberately gross / unsettling but Safe-For-Work:
// deep-sea creatures, parasites, extreme insect close-ups, fungi, etc.
// Everything imported still lands in the `pending` moderation queue — nothing
// goes live until a human approves it.

import { isPhoneFriendly } from './aspect.js';

const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';

export const HORROR_CATEGORIES = [
  'Deep sea creatures',
  'Anglerfish',
  'Isopoda',
  'Parasites',
  'Ticks',
  'Botfly',
  'Spiders',
  'Scolopendra',
  'Slime molds',
  'Mold',
  'Deep-sea fish',
  'Leeches',
];

const IMAGE_EXT = /\.(jpe?g|png)$/i;

async function commons(params) {
  const url = new URL(COMMONS_API);
  url.search = new URLSearchParams({
    format: 'json',
    origin: '*',
    ...params,
  }).toString();
  const res = await fetch(url, {
    headers: { 'User-Agent': 'CastleHassle/0.1 (horror-of-the-day; contact: maintainers)' },
  });
  if (!res.ok) throw new Error(`Commons API ${res.status} for ${params.titles || params.gcmtitle}`);
  return res.json();
}

/**
 * Fetch up to `limit` image candidates from a single Commons category.
 * Returns [{ title, image_url, source_url, credit }].
 */
export async function fetchCategory(category, limit = 10, { phoneOnly = true } = {}) {
  const data = await commons({
    action: 'query',
    generator: 'categorymembers',
    gcmtitle: `Category:${category}`,
    gcmtype: 'file',
    gcmlimit: String(Math.min(limit * 4, 100)), // over-fetch: many will be landscape
    prop: 'imageinfo',
    iiprop: 'url|size|extmetadata',
    iiurlwidth: '1290', // request a phone-wallpaper-friendly rendering
  });

  const pages = data?.query?.pages ?? {};
  const out = [];
  for (const page of Object.values(pages)) {
    const info = page.imageinfo?.[0];
    if (!info) continue;
    const file = info.url || '';
    if (!IMAGE_EXT.test(file)) continue; // skip SVG/GIF/video/etc.

    const width = info.width ?? null;
    const height = info.height ?? null;
    // Only pull portrait/square images so wallpapers fit a phone cleanly.
    if (phoneOnly && !isPhoneFriendly(width, height)) continue;

    const meta = info.extmetadata ?? {};
    const artist = stripHtml(meta.Artist?.value);
    const license = meta.LicenseShortName?.value;
    out.push({
      title: page.title.replace(/^File:/, '').replace(IMAGE_EXT, ''),
      image_url: info.thumburl || info.url,
      source_url: info.descriptionurl || `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title)}`,
      credit: [artist, license].filter(Boolean).join(' · ') || 'Wikimedia Commons',
      width,
      height,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** Pull from several categories at once, de-duplicated by image URL. */
export async function fetchCandidates({ categories = HORROR_CATEGORIES, perCategory = 5, phoneOnly = true } = {}) {
  const seen = new Set();
  const results = [];
  for (const cat of categories) {
    try {
      const items = await fetchCategory(cat, perCategory, { phoneOnly });
      for (const item of items) {
        if (seen.has(item.image_url)) continue;
        seen.add(item.image_url);
        results.push({ ...item, category: cat });
      }
    } catch (err) {
      // One bad category shouldn't abort the whole import.
      console.warn(`[wikimedia] skipping "${cat}": ${err.message}`);
    }
  }
  return results;
}

// Derive a Commons "File:Name.ext" title from an image URL we stored, so we can
// look up its dimensions later. Handles Special:FilePath links (seed data) and
// upload.wikimedia.org thumbnail URLs (imported data).
export function fileTitleFromUrl(url = '') {
  // Commons normalizes "_" and " " to the same title; the API returns spaces,
  // so normalize here too or the backfill's title keys won't match the response.
  const norm = (name) => `File:${decodeURIComponent(name).replace(/_/g, ' ')}`;
  const fp = url.match(/Special:FilePath\/([^?#]+)/i);
  if (fp) return norm(fp[1]);
  const thumb = url.match(/\/commons\/(?:thumb\/)?[0-9a-f]\/[0-9a-f]{2}\/([^/]+?\.(?:jpe?g|png))/i);
  if (thumb) return norm(thumb[1]);
  return null;
}

/** Look up { width, height } for up to 50 Commons file titles at once. */
export async function fetchDimensionsForTitles(titles) {
  if (!titles.length) return {};
  const data = await commons({
    action: 'query',
    titles: titles.slice(0, 50).join('|'),
    prop: 'imageinfo',
    iiprop: 'size',
  });
  const pages = data?.query?.pages ?? {};
  const dims = {};
  for (const page of Object.values(pages)) {
    const info = page.imageinfo?.[0];
    if (info?.width && info?.height) dims[page.title] = { width: info.width, height: info.height };
  }
  return dims;
}

function stripHtml(html) {
  if (!html) return null;
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim() || null;
}
