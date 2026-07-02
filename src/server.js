import express from 'express';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import multer from 'multer';
import { imageSize } from 'image-size';
import * as store from './store.js';
import { fetchCandidates, HORROR_CATEGORIES } from './wikimedia.js';
import { buildWallpaperShortcut } from './shortcut.js';
import { runNightly, scheduleNightly, backfillDimensions, tomorrow } from './nightly.js';
import { isPhoneFriendly } from './aspect.js';
import { notifySubmissionAsync, sendPush, ntfyConfig } from './notify.js';
import { renderWallpaperCached } from './wallpaper.js';
import { runSeed } from './seed.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', true); // honor X-Forwarded-Proto/Host so generated URLs are correct behind a proxy
app.use(express.json({ limit: '64kb' }));

// Serve index.html with the absolute origin injected, so link-preview meta tags
// (og:image etc.) resolve for iMessage/social regardless of the deployed host.
const INDEX_HTML = readFileSync(`${__dirname}/../public/index.html`, 'utf8');
app.get(['/', '/index.html'], (req, res) => {
  try { store.recordMetric('page_view'); } catch { /* analytics are best-effort */ }
  const origin = `${req.protocol}://${req.get('host')}`;
  res.type('html').send(INDEX_HTML.replaceAll('%%ORIGIN%%', origin));
});

app.use(express.static(`${__dirname}/../public`));

const ADMIN_KEY = process.env.CH_ADMIN_KEY || 'dev-admin-key';
// Public submissions are on by default; set CH_ALLOW_SUBMISSIONS=0 to close them.
const SUBMISSIONS_ENABLED = process.env.CH_ALLOW_SUBMISSIONS !== '0';

// Accept image uploads up to 10MB, held in memory (then stored in the DB).
const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, Boolean(MIME_EXT[file.mimetype])),
});

function requireAdmin(req, res, next) {
  const key = req.get('x-admin-key') || req.query.key;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'admin key required' });
  next();
}

function toPublic(img) {
  if (!img) return null;
  return {
    id: img.id,
    title: img.title,
    image_url: img.image_url,
    source_url: img.source_url,
    credit: img.credit,
    score: img.score ?? undefined,
    upvotes: img.upvotes ?? undefined,
    downvotes: img.downvotes ?? undefined,
    day: img.day ?? undefined,
    width: img.width ?? undefined,
    height: img.height ?? undefined,
    phone_friendly: img.width && img.height ? isPhoneFriendly(img.width, img.height) : undefined,
  };
}

// --- Public read endpoints -------------------------------------------------

// Next daily refresh = next UTC midnight (when a new day's horror is picked).
function nextRefreshISO() {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0));
  return next.toISOString();
}

app.get('/api/today', (req, res) => {
  const horror = store.horrorOfTheDay();
  if (!horror) return res.status(404).json({ error: 'no approved images yet', next_refresh: nextRefreshISO() });
  res.json({ day: store.today(), horror: toPublic(horror), next_refresh: nextRefreshISO() });
});

app.get('/api/candidates', (req, res) => {
  const voterToken = req.query.voter_token;
  const mine = voterToken ? store.myVoteMap(voterToken) : null;
  const candidates = store.leaderboard(50).map((img) => {
    const pub = toPublic(img);
    if (mine) pub.my_vote = mine[img.id] ?? 0;
    return pub;
  });
  res.json({
    candidates,
    votes_remaining: voterToken ? store.votesRemaining(voterToken) : undefined,
    daily_vote_limit: store.DAILY_VOTE_LIMIT,
  });
});

app.get('/api/history', (req, res) => {
  res.json({ history: store.recentSelections(30).map(toPublic) });
});

app.get('/api/stats', (req, res) => {
  res.json(store.stats());
});

// Frontend config. If CH_SHORTCUT_ICLOUD_URL is set (an Apple-signed iCloud
// share link), the setup flow uses it and drops the "Allow Untrusted Shortcuts"
// step — signed shortcuts import with no settings change.
app.get('/api/config', (req, res) => {
  const iCloud = process.env.CH_SHORTCUT_ICLOUD_URL;
  res.json({
    iosShortcutUrl: iCloud || '/api/ios/shortcut',
    iosShortcutSigned: Boolean(iCloud),
    submissionsEnabled: SUBMISSIONS_ENABLED,
  });
});

// Resolve an image row to its raw source bytes: uploaded images come from the
// DB, everything else is fetched from its URL.
async function sourceBytesFor(image) {
  const local = image.image_url.match(/^\/api\/images\/([^./]+)/);
  if (local) {
    const file = store.getImageFile(local[1]);
    if (!file) throw new Error('uploaded image missing');
    return file.data;
  }
  const r = await fetch(image.image_url);
  if (!r.ok) throw new Error(`source fetch ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

function absoluteImageUrl(req, image) {
  return image.image_url.startsWith('/')
    ? `${req.protocol}://${req.get('host')}${image.image_url}`
    : image.image_url;
}

// The endpoint the iOS Shortcut hits. Serves a processed full-bleed wallpaper
// (fills the phone, smart-cropped, dark background). `?raw=1` (or
// CH_WALLPAPER_RAW=1) 302-redirects to the untouched original instead.
app.get('/api/wallpaper/today.jpg', async (req, res) => {
  try { store.recordMetric('wallpaper_fetch'); } catch { /* best-effort */ }
  const horror = store.horrorOfTheDay();
  if (!horror) return res.status(404).json({ error: 'no approved images yet' });

  if (req.query.raw === '1' || process.env.CH_WALLPAPER_RAW === '1') {
    return res.redirect(302, absoluteImageUrl(req, horror));
  }
  try {
    const out = await renderWallpaperCached(horror.image_url, await sourceBytesFor(horror));
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=3600');
    return res.send(out);
  } catch {
    // Never leave the phone without a wallpaper — fall back to the original.
    return res.redirect(302, absoluteImageUrl(req, horror));
  }
});

// Processed wallpaper preview for any image by id (used by the dashboard).
app.get('/api/wallpaper/preview.jpg', async (req, res) => {
  const image = store.getImage(Number(req.query.image_id));
  if (!image) return res.status(404).json({ error: 'image not found' });
  try {
    const out = await renderWallpaperCached(image.image_url, await sourceBytesFor(image));
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(out);
  } catch (err) {
    res.status(502).json({ error: `preview failed: ${err.message}` });
  }
});

// One-tap iOS setup: download a Shortcut that fetches the daily wallpaper URL
// and sets it as the wallpaper. It's an unsigned shortcut, so the user must
// enable Settings → Shortcuts → Allow Untrusted Shortcuts to import it.
app.get('/api/ios/shortcut', (req, res) => {
  const wallpaperUrl = `${req.protocol}://${req.get('host')}/api/wallpaper/today.jpg`;
  const shortcut = buildWallpaperShortcut(wallpaperUrl);
  res.set('Content-Type', 'application/octet-stream');
  res.set('Content-Disposition', 'attachment; filename="Horror of the Day.shortcut"');
  res.send(shortcut);
});

// --- Public write endpoints ------------------------------------------------

// Accepts either an uploaded image file (multipart, field "image") or an
// https image URL (JSON or form field). Uploads are stored in the DB and served
// from /api/images/<hash>.<ext>.
app.post('/api/submit', upload.single('image'), (req, res) => {
  if (!SUBMISSIONS_ENABLED) {
    return res.status(403).json({ error: 'public submissions are currently closed' });
  }
  const body = req.body ?? {};
  const title = body.title?.trim();
  const source_url = body.source_url || undefined;
  const credit = body.credit || undefined;
  const submitted_by = body.submitted_by || undefined;

  if (!title) return res.status(400).json({ error: 'title is required' });

  let image_url = body.image_url?.trim();
  let width = null;
  let height = null;

  if (req.file) {
    // Uploaded file: hash → dedupe, measure, store bytes, reference by URL.
    const ext = MIME_EXT[req.file.mimetype];
    if (!ext) return res.status(400).json({ error: 'unsupported image type (use JPEG, PNG, or WebP)' });
    const hash = createHash('sha256').update(req.file.buffer).digest('hex');
    try {
      const dim = imageSize(req.file.buffer);
      width = dim.width ?? null;
      height = dim.height ?? null;
    } catch {
      /* couldn't measure — leave dimensions unknown */
    }
    store.saveImageFile(hash, req.file.mimetype, req.file.buffer);
    image_url = `/api/images/${hash}.${ext}`;
  } else if (!image_url) {
    return res.status(400).json({ error: 'attach an image file or provide an image_url' });
  } else if (!/^https:\/\//i.test(image_url)) {
    return res.status(400).json({ error: 'image_url must be an https URL' });
  }

  try {
    const result = store.addImage({ title, image_url, source_url, credit, submitted_by, status: 'pending', width, height });
    if (result.created) {
      // Ping the moderator (best-effort; never blocks the response).
      const origin = `${req.protocol}://${req.get('host')}`;
      const absImage = image_url.startsWith('/') ? `${origin}${image_url}` : image_url;
      notifySubmissionAsync({ title, imageUrl: absImage, adminUrl: `${origin}/admin.html` });
    }
    res.status(result.created ? 201 : 200).json({
      ...result,
      message: result.created
        ? 'Submitted! It will appear once a moderator approves it.'
        : 'That image was already submitted.',
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Serve an uploaded image's bytes by content hash.
app.get('/api/images/:file', (req, res) => {
  const hash = String(req.params.file).replace(/\.[a-z0-9]+$/i, '');
  const file = store.getImageFile(hash);
  if (!file) return res.status(404).json({ error: 'image not found' });
  res.set('Content-Type', file.mime);
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(file.data);
});

app.post('/api/candidates/:id/vote', (req, res) => {
  const id = Number(req.params.id);
  const { voter_token, value } = req.body ?? {};
  try {
    const result = store.vote(id, voter_token, value === -1 ? -1 : 1);
    res.json({ id, score: result.score, my_vote: result.myVote, votes_remaining: result.remaining });
  } catch (err) {
    const code =
      err.code === 'VOTE_LIMIT' ? 429 : err.message === 'image not found' ? 404 : 400;
    res.status(code).json({ error: err.message });
  }
});

// --- Moderation (admin) ----------------------------------------------------

app.get('/api/moderation/pending', requireAdmin, (req, res) => {
  res.json({ pending: store.listByStatus('pending', 200).map(toPublic) });
});

app.post('/api/moderation/:id/approve', requireAdmin, (req, res) => {
  const ok = store.setStatus(Number(req.params.id), 'approved');
  res.status(ok ? 200 : 404).json({ ok });
});

app.post('/api/moderation/:id/reject', requireAdmin, (req, res) => {
  const ok = store.setStatus(Number(req.params.id), 'rejected');
  res.status(ok ? 200 : 404).json({ ok });
});

// Full dashboard snapshot: today/tomorrow picks, leaderboard, counts, and
// analytics trends over the last `days` (default 14).
app.get('/api/moderation/overview', requireAdmin, (req, res) => {
  const days = Math.min(60, Math.max(7, Number(req.query.days) || 14));
  const todayDay = store.today();
  const tmrwDay = tomorrow();
  res.json({
    today: { day: todayDay, horror: toPublic(store.selectionFor(todayDay)) },
    tomorrow: { day: tmrwDay, horror: toPublic(store.selectionFor(tmrwDay)) },
    counts: store.stats(),
    metrics: {
      pageViewsTotal: store.metricTotal('page_view'),
      wallpaperFetchesTotal: store.metricTotal('wallpaper_fetch'),
    },
    leaderboard: store.leaderboard(100).map(toPublic),
    trends: {
      pageViews: store.metricSeries('page_view', days),
      wallpaperFetches: store.metricSeries('wallpaper_fetch', days),
      votes: store.votesPerDay(days),
      submissions: store.submissionsPerDay(days),
    },
  });
});

// Override (or clear) which image is featured on a given day.
app.post('/api/moderation/select', requireAdmin, (req, res) => {
  const { day, image_id } = req.body ?? {};
  let target;
  if (!day || day === 'today') target = store.today();
  else if (day === 'tomorrow') target = tomorrow();
  else if (/^\d{4}-\d{2}-\d{2}$/.test(day)) target = day;
  else return res.status(400).json({ error: 'day must be "today", "tomorrow", or YYYY-MM-DD' });
  try {
    const result = store.setSelection(target, image_id ?? null);
    res.json({ ...result, horror: toPublic(store.selectionFor(target)) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Clear all votes for an image.
app.post('/api/moderation/:id/reset-votes', requireAdmin, (req, res) => {
  const removed = store.resetVotes(Number(req.params.id));
  res.json({ ok: true, removed });
});

// Pull fresh candidates from Wikimedia Commons into the pending queue.
app.post('/api/moderation/import', requireAdmin, async (req, res) => {
  const { categories, perCategory } = req.body ?? {};
  try {
    const found = await fetchCandidates({
      categories: Array.isArray(categories) && categories.length ? categories : HORROR_CATEGORIES,
      perCategory: Number(perCategory) || 5,
    });
    let added = 0;
    for (const item of found) {
      const { created } = store.addImage({ ...item, submitted_by: 'wikimedia-import', status: 'pending' });
      if (created) added += 1;
    }
    res.json({ found: found.length, added, queued_for_review: true });
  } catch (err) {
    res.status(502).json({ error: `import failed: ${err.message}` });
  }
});

// Manually trigger the nightly job (import + pre-select tomorrow) on demand.
app.post('/api/moderation/nightly', requireAdmin, async (req, res) => {
  const { import: doImport = true, perCategory } = req.body ?? {};
  try {
    const summary = await runNightly({
      doImport: doImport !== false,
      perCategory: Number(perCategory) || 5,
    });
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Measure any stored images missing pixel dimensions (so selection can prefer
// portrait). Runs automatically in the nightly job; this triggers it on demand.
app.post('/api/moderation/backfill-dimensions', requireAdmin, async (req, res) => {
  try {
    const result = await backfillDimensions({ limit: Number(req.body?.limit) || 200 });
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: `backfill failed: ${err.message}` });
  }
});

// Send a test push so you can confirm ntfy is wired up before going live.
app.post('/api/moderation/test-notify', requireAdmin, async (req, res) => {
  if (!ntfyConfig()) {
    return res.status(400).json({ error: 'notifications are off — set CH_NTFY_TOPIC' });
  }
  const origin = `${req.protocol}://${req.get('host')}`;
  const result = await sendPush({
    title: 'Horror of the Day',
    body: 'Test notification — you’re set up! 🎉',
    click: `${origin}/admin.html`,
  });
  res.status(result.sent ? 200 : 502).json(result);
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Turn multer upload errors (e.g. file too large) into clean JSON responses.
app.use((err, req, res, next) => {
  if (err && err.name === 'MulterError') {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'image too large (max 10MB)' : err.message;
    return res.status(400).json({ error: msg });
  }
  next(err);
});

const PORT = process.env.PORT || 3000;

// Only start listening when run directly (not when imported by tests).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  app.listen(PORT, () => {
    // Auto-seed a fresh/empty catalog so a new deploy has content on first boot
    // without a manual shell step. Disable with CH_SEED_ON_START=0.
    if (process.env.CH_SEED_ON_START !== '0' && store.stats().approved === 0) {
      const r = runSeed();
      console.log(`   Auto-seeded ${r.added} starter image(s) into an empty catalog.`);
    }
    console.log(`🫣 Horror of the Day running on http://localhost:${PORT}`);
    console.log(`   Horror-of-the-day API:  GET /api/today`);
    console.log(`   Wallpaper for Shortcut: GET /api/wallpaper/today.jpg`);
    console.log(`   Admin key: ${ADMIN_KEY === 'dev-admin-key' ? '(using insecure dev default — set CH_ADMIN_KEY)' : '(set)'}`);
    // Opt-in in-process nightly scheduler (CH_NIGHTLY=1); otherwise use `npm run nightly` via cron.
    if (process.env.CH_NIGHTLY === '1') scheduleNightly();
  });
}

export default app;
