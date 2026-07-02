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
import { runNightly, scheduleNightly, backfillDimensions } from './nightly.js';
import { isPhoneFriendly } from './aspect.js';
import { notifySubmissionAsync, sendPush, ntfyConfig } from './notify.js';
import { runSeed } from './seed.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', true); // honor X-Forwarded-Proto/Host so generated URLs are correct behind a proxy
app.use(express.json({ limit: '64kb' }));

// Serve index.html with the absolute origin injected, so link-preview meta tags
// (og:image etc.) resolve for iMessage/social regardless of the deployed host.
const INDEX_HTML = readFileSync(`${__dirname}/../public/index.html`, 'utf8');
app.get(['/', '/index.html'], (req, res) => {
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

app.get('/api/today', (req, res) => {
  const horror = store.horrorOfTheDay();
  if (!horror) return res.status(404).json({ error: 'no approved images yet' });
  res.json({ day: store.today(), horror: toPublic(horror) });
});

app.get('/api/candidates', (req, res) => {
  res.json({ candidates: store.leaderboard(50).map(toPublic) });
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

// The endpoint an iOS Shortcut / Android job hits to grab today's wallpaper.
// 302-redirects straight to the image bytes so "Get Contents of URL" just works.
app.get('/api/wallpaper/today.jpg', (req, res) => {
  const horror = store.horrorOfTheDay();
  if (!horror) return res.status(404).json({ error: 'no approved images yet' });
  // Uploaded images are stored as site-relative URLs; make them absolute so the
  // iOS Shortcut's "Get Contents of URL" can fetch them.
  const url = horror.image_url.startsWith('/')
    ? `${req.protocol}://${req.get('host')}${horror.image_url}`
    : horror.image_url;
  res.redirect(302, url);
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
    const score = store.vote(id, voter_token, value === -1 ? -1 : 1);
    res.json({ id, score });
  } catch (err) {
    const code = err.message === 'image not found' ? 404 : 400;
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
