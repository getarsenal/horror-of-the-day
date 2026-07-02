// Nightly job: keep the review queue fed and pre-select tomorrow's horror so
// the app is hands-off. Two independent steps, either of which can be disabled:
//
//   1. Import fresh candidates from Wikimedia Commons into the *pending* queue
//      (still human-moderated — the NSFW guardrail is never bypassed).
//   2. Pre-select tomorrow's Horror of the Day from the current leaderboard, so
//      the pick is locked in overnight rather than at the first page view.
//
// The importer is injected so this is testable without network access, and so
// step 2 still runs even if the import fails (e.g. blocked egress).

import * as store from './store.js';
import { fetchCandidates, fetchDimensionsForTitles, fileTitleFromUrl, HORROR_CATEGORIES } from './wikimedia.js';

/** The YYYY-MM-DD (UTC) date one day after `now`. */
export function tomorrow(now = new Date()) {
  return store.today(new Date(now.getTime() + 24 * 60 * 60 * 1000));
}

/**
 * Measure any stored images that don't have pixel dimensions yet (seed data,
 * older imports) so the daily selection can prefer phone-shaped ones. `lookup`
 * is injectable for tests. Best-effort: unmeasurable URLs are skipped.
 */
export async function backfillDimensions({ limit = 200, lookup = fetchDimensionsForTitles, log = () => {} } = {}) {
  const missing = store.imagesMissingDimensions(limit);
  if (!missing.length) return { measured: 0, missing: 0 };

  const idsByTitle = new Map();
  for (const img of missing) {
    const title = fileTitleFromUrl(img.image_url);
    if (!title) continue;
    if (!idsByTitle.has(title)) idsByTitle.set(title, []);
    idsByTitle.get(title).push(img.id);
  }

  const titles = [...idsByTitle.keys()];
  let measured = 0;
  for (let i = 0; i < titles.length; i += 50) {
    const dims = await lookup(titles.slice(i, i + 50));
    for (const [title, { width, height }] of Object.entries(dims)) {
      for (const id of idsByTitle.get(title) ?? []) {
        if (store.setDimensions(id, width, height)) measured += 1;
      }
    }
  }
  log(`dimensions: measured ${measured}/${missing.length} unmeasured image(s)`);
  return { measured, missing: missing.length };
}

export async function runNightly({
  now = new Date(),
  doImport = true,
  categories = HORROR_CATEGORIES,
  perCategory = 5,
  cooldownDays = 7,
  importer = fetchCandidates, // injectable for tests
  dimensionLookup = fetchDimensionsForTitles, // injectable for tests
  log = () => {},
} = {}) {
  const summary = { ranAt: now.toISOString(), import: null, dimensions: null, preselected: null };

  // Step 1: import into the moderation queue (best-effort).
  if (doImport) {
    try {
      const found = await importer({ categories, perCategory });
      let added = 0;
      for (const item of found) {
        const { created } = store.addImage({
          ...item,
          submitted_by: 'nightly-import',
          status: 'pending',
        });
        if (created) added += 1;
      }
      summary.import = { found: found.length, added };
      log(`import: found ${found.length}, added ${added} new to the review queue`);
    } catch (err) {
      // A failed import must not block pre-selection.
      summary.import = { error: err.message };
      log(`import skipped: ${err.message}`);
    }
  }

  // Step 1b: measure images missing dimensions so selection can prefer portrait.
  try {
    summary.dimensions = await backfillDimensions({ lookup: dimensionLookup, log });
  } catch (err) {
    summary.dimensions = { error: err.message };
    log(`dimensions backfill skipped: ${err.message}`);
  }

  // Step 2: pre-select tomorrow's horror (idempotent — a second run is a no-op).
  const day = tomorrow(now);
  const pick = store.horrorOfTheDay(day, { cooldownDays });
  summary.preselected = pick
    ? { day, id: pick.id, title: pick.title, score: pick.score }
    : null;
  log(
    pick
      ? `pre-selected ${day}: #${pick.id} "${pick.title}" (score ${pick.score})`
      : `pre-select ${day}: no eligible approved images yet`
  );

  return summary;
}

// Optional in-process scheduler so `npm start` alone can be hands-off. Opt-in
// via CH_NIGHTLY=1 to avoid double-running when an external cron is used.
// Runs daily at CH_NIGHTLY_HOUR (UTC, default 03:00).
export function scheduleNightly({ log = console.log } = {}) {
  const hour = clampHour(Number(process.env.CH_NIGHTLY_HOUR ?? 3));
  const doImport = process.env.CH_NIGHTLY_IMPORT !== '0';

  const tick = async () => {
    try {
      await runNightly({ doImport, log: (m) => log(`[nightly] ${m}`) });
    } catch (err) {
      log(`[nightly] run failed: ${err.message}`);
    }
    setTimeout(tick, 24 * 60 * 60 * 1000).unref?.();
  };

  const delay = msUntilHour(hour);
  setTimeout(tick, delay).unref?.();
  log(`[nightly] scheduled daily at ${String(hour).padStart(2, '0')}:00 UTC (import ${doImport ? 'on' : 'off'})`);
}

function clampHour(h) {
  return Number.isFinite(h) ? Math.min(23, Math.max(0, Math.trunc(h))) : 3;
}

function msUntilHour(hour, now = new Date()) {
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, 0, 0, 0)
  );
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}
