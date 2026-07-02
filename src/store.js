import db from './db.js';
import { isPhoneFriendly } from './aspect.js';

/** Today's date in YYYY-MM-DD (UTC). Override for testing/timezones. */
export function today(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

/**
 * Add a candidate image. New images land in the moderation queue as `pending`
 * unless explicitly approved (e.g. trusted curated seed data).
 * Returns { id, created } — created=false if the URL already existed.
 */
export function addImage({ title, image_url, source_url, credit, submitted_by, status, width, height }) {
  if (!title || !image_url) throw new Error('title and image_url are required');
  const existing = db.prepare('SELECT id FROM images WHERE image_url = ?').get(image_url);
  if (existing) return { id: existing.id, created: false };

  const info = db
    .prepare(
      `INSERT INTO images (title, image_url, source_url, credit, submitted_by, status, width, height)
       VALUES (@title, @image_url, @source_url, @credit, @submitted_by, @status, @width, @height)`
    )
    .run({
      title,
      image_url,
      source_url: source_url ?? null,
      credit: credit ?? null,
      submitted_by: submitted_by ?? null,
      status: status ?? 'pending',
      width: width ?? null,
      height: height ?? null,
    });
  return { id: info.lastInsertRowid, created: true };
}

/** Record measured pixel dimensions for an image (used by the backfill). */
export function setDimensions(id, width, height) {
  const info = db.prepare('UPDATE images SET width = ?, height = ? WHERE id = ?').run(width, height, id);
  return info.changes > 0;
}

/** Images we haven't measured yet, so the backfill can fill them in. */
export function imagesMissingDimensions(limit = 100) {
  return db
    .prepare('SELECT id, image_url FROM images WHERE width IS NULL OR height IS NULL LIMIT ?')
    .all(limit);
}

/** Store uploaded image bytes, keyed by content hash (idempotent). */
export function saveImageFile(hash, mime, data) {
  db.prepare('INSERT OR IGNORE INTO image_files (hash, mime, data) VALUES (?, ?, ?)').run(hash, mime, data);
  return hash;
}

/** Fetch stored bytes for an uploaded image by hash, or null. */
export function getImageFile(hash) {
  return db.prepare('SELECT mime, data FROM image_files WHERE hash = ?').get(hash) ?? null;
}

export function setStatus(id, status) {
  const info = db.prepare('UPDATE images SET status = ? WHERE id = ?').run(status, id);
  return info.changes > 0;
}

export function getImage(id) {
  return db.prepare('SELECT * FROM images WHERE id = ?').get(id);
}

export function listByStatus(status, limit = 100) {
  return db
    .prepare('SELECT * FROM images WHERE status = ? ORDER BY created_at DESC LIMIT ?')
    .all(status, limit);
}

/**
 * Cast (or change) a vote. value must be +1 or -1. One vote per voter per image;
 * re-voting overwrites the previous value. Returns the image's new score.
 */
export function vote(imageId, voterToken, value = 1) {
  if (![1, -1].includes(value)) throw new Error('vote value must be 1 or -1');
  const img = getImage(imageId);
  if (!img) throw new Error('image not found');
  if (img.status !== 'approved') throw new Error('image is not open for voting');
  if (!voterToken) throw new Error('voter token required');

  db.prepare(
    `INSERT INTO votes (image_id, voter_token, value) VALUES (?, ?, ?)
     ON CONFLICT (image_id, voter_token) DO UPDATE SET value = excluded.value`
  ).run(imageId, voterToken, value);

  return scoreFor(imageId);
}

export function scoreFor(imageId) {
  const row = db
    .prepare('SELECT COALESCE(SUM(value), 0) AS score FROM votes WHERE image_id = ?')
    .get(imageId);
  return row.score;
}

/**
 * Approved candidates ranked by net score (upvotes minus downvotes), newest as
 * tie-breaker. This is the leaderboard the community is fighting over.
 */
export function leaderboard(limit = 50) {
  return db
    .prepare(
      `SELECT i.*,
              COALESCE(SUM(v.value), 0)                       AS score,
              COALESCE(SUM(CASE WHEN v.value = 1  THEN 1 END), 0) AS upvotes,
              COALESCE(SUM(CASE WHEN v.value = -1 THEN 1 END), 0) AS downvotes
         FROM images i
         LEFT JOIN votes v ON v.image_id = i.id
        WHERE i.status = 'approved'
        GROUP BY i.id
        ORDER BY score DESC, i.created_at DESC
        LIMIT ?`
    )
    .all(limit);
}

/**
 * The Horror of the Day. If a selection already exists for `day` we return it
 * (the image is fixed for the whole day). Otherwise we pick the top-voted
 * approved image that has NOT been featured in the last `cooldownDays`, record
 * it, and return it. Returns null if there are no eligible images at all.
 */
export function horrorOfTheDay(day = today(), { cooldownDays = 7 } = {}) {
  const existing = db
    .prepare(
      `SELECT i.*, d.score_at_pick AS score
         FROM daily_selections d JOIN images i ON i.id = d.image_id
        WHERE d.day = ?`
    )
    .get(day);
  if (existing) return existing;

  // Candidates: approved, and not featured within the cooldown window.
  const board = leaderboard(200).filter((img) => !featuredRecently(img.id, day, cooldownDays));
  // Prefer phone-shaped (portrait/square) images so wallpapers fit cleanly;
  // only fall back to landscape/unmeasured images if there are no good ones.
  const friendly = board.filter((img) => isPhoneFriendly(img.width, img.height));
  const pool = friendly.length ? friendly : board;
  // If everything is on cooldown (small catalogs), fall back to the full board.
  const pick = pool[0] ?? leaderboard(1)[0];
  if (!pick) return null;

  db.prepare(
    'INSERT OR IGNORE INTO daily_selections (day, image_id, score_at_pick) VALUES (?, ?, ?)'
  ).run(day, pick.id, pick.score);

  // Re-read to guard against a race where another request inserted first.
  return horrorOfTheDay(day, { cooldownDays });
}

function featuredRecently(imageId, day, cooldownDays) {
  const row = db
    .prepare(
      `SELECT 1 FROM daily_selections
        WHERE image_id = ?
          AND day < ?
          AND day >= date(?, '-' || ? || ' days')
        LIMIT 1`
    )
    .get(imageId, day, day, cooldownDays);
  return !!row;
}

export function recentSelections(limit = 30) {
  return db
    .prepare(
      `SELECT d.day, d.score_at_pick AS score, i.*
         FROM daily_selections d JOIN images i ON i.id = d.image_id
        ORDER BY d.day DESC LIMIT ?`
    )
    .all(limit);
}

// --- Metrics ---------------------------------------------------------------

/** Increment a daily counter (best-effort analytics; no PII). */
export function recordMetric(kind, day = today()) {
  db.prepare(
    `INSERT INTO metrics (day, kind, count) VALUES (?, ?, 1)
     ON CONFLICT (day, kind) DO UPDATE SET count = count + 1`
  ).run(day, kind);
}

export function metricTotal(kind) {
  return db.prepare('SELECT COALESCE(SUM(count), 0) AS n FROM metrics WHERE kind = ?').get(kind).n;
}

/** Last `days` days of a metric as [{ day, count }], oldest→newest, zero-filled. */
export function metricSeries(kind, days = 14, end = today()) {
  const rows = db
    .prepare(
      `SELECT day, count FROM metrics
        WHERE kind = ? AND day > date(?, '-' || ? || ' days') AND day <= ?`
    )
    .all(kind, end, days, end);
  return fillDays(rows, days, end);
}

/** Votes cast per day (by votes.created_at) over the last `days`. */
export function votesPerDay(days = 14, end = today()) {
  const rows = db
    .prepare(
      `SELECT date(created_at) AS day, COUNT(*) AS count FROM votes
        WHERE date(created_at) > date(?, '-' || ? || ' days') AND date(created_at) <= ?
        GROUP BY date(created_at)`
    )
    .all(end, days, end);
  return fillDays(rows, days, end);
}

/** Images submitted per day over the last `days`. */
export function submissionsPerDay(days = 14, end = today()) {
  const rows = db
    .prepare(
      `SELECT date(created_at) AS day, COUNT(*) AS count FROM images
        WHERE date(created_at) > date(?, '-' || ? || ' days') AND date(created_at) <= ?
        GROUP BY date(created_at)`
    )
    .all(end, days, end);
  return fillDays(rows, days, end);
}

// Turn sparse [{day,count}] rows into a dense, zero-filled series ending at `end`.
function fillDays(rows, days, end) {
  const byDay = new Map(rows.map((r) => [r.day, r.count]));
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = db.prepare("SELECT date(?, '-' || ? || ' days') AS day").get(end, i).day;
    out.push({ day: d, count: byDay.get(d) ?? 0 });
  }
  return out;
}

// --- Manual daily-selection control (admin overrides) ----------------------

/** Read the selection for a day without creating one (unlike horrorOfTheDay). */
export function selectionFor(day = today()) {
  return db
    .prepare(
      `SELECT i.*, d.score_at_pick AS score, d.day AS day
         FROM daily_selections d JOIN images i ON i.id = d.image_id
        WHERE d.day = ?`
    )
    .get(day);
}

/**
 * Force a specific image as the Horror for `day` (admin override), or clear the
 * selection (imageId null) so it auto-picks again. The image must be approved.
 */
export function setSelection(day, imageId) {
  if (imageId == null) {
    db.prepare('DELETE FROM daily_selections WHERE day = ?').run(day);
    return { day, cleared: true };
  }
  const img = getImage(imageId);
  if (!img) throw new Error('image not found');
  if (img.status !== 'approved') throw new Error('image must be approved before featuring');
  db.prepare(
    `INSERT INTO daily_selections (day, image_id, score_at_pick) VALUES (?, ?, ?)
     ON CONFLICT (day) DO UPDATE SET image_id = excluded.image_id, score_at_pick = excluded.score_at_pick`
  ).run(day, imageId, scoreFor(imageId));
  return { day, image_id: imageId };
}

/** Clear all votes for an image (admin). Returns votes removed. */
export function resetVotes(imageId) {
  return db.prepare('DELETE FROM votes WHERE image_id = ?').run(imageId).changes;
}

export function stats() {
  const c = (sql, ...a) => db.prepare(sql).get(...a).n;
  return {
    approved: c("SELECT COUNT(*) n FROM images WHERE status = 'approved'"),
    pending: c("SELECT COUNT(*) n FROM images WHERE status = 'pending'"),
    rejected: c("SELECT COUNT(*) n FROM images WHERE status = 'rejected'"),
    total_votes: c('SELECT COUNT(*) n FROM votes'),
    days_featured: c('SELECT COUNT(*) n FROM daily_selections'),
  };
}
