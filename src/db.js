import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// DB path is configurable so tests can use an in-memory / temp database.
const DB_PATH = process.env.CH_DB_PATH || `${__dirname}/../data/horror-of-the-day.db`;

if (DB_PATH !== ':memory:') {
  mkdirSync(dirname(DB_PATH), { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS images (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    title        TEXT NOT NULL,
    image_url    TEXT NOT NULL UNIQUE,
    source_url   TEXT,
    credit       TEXT,
    -- pending -> awaiting moderation, approved -> votable, rejected -> hidden
    status       TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'approved', 'rejected')),
    submitted_by TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS votes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    image_id     INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    voter_token  TEXT NOT NULL,
    -- +1 = "yes, horrifying", -1 = "not scary enough"
    value        INTEGER NOT NULL DEFAULT 1 CHECK (value IN (-1, 1)),
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (image_id, voter_token)
  );

  -- One featured "Horror of the Day" per calendar date.
  CREATE TABLE IF NOT EXISTS daily_selections (
    day          TEXT PRIMARY KEY,          -- YYYY-MM-DD
    image_id     INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    score_at_pick INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Bytes for user-uploaded images, keyed by content hash (dedupes identical
  -- uploads). URL-based images don't have a row here.
  CREATE TABLE IF NOT EXISTS image_files (
    hash        TEXT PRIMARY KEY,          -- sha256 of the bytes
    mime        TEXT NOT NULL,
    data        BLOB NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_votes_image ON votes(image_id);
  CREATE INDEX IF NOT EXISTS idx_images_status ON images(status);
`);

// --- Migrations for existing databases ------------------------------------
// Add image dimension columns if an older DB predates them.
const imageCols = db.prepare('PRAGMA table_info(images)').all().map((c) => c.name);
if (!imageCols.includes('width')) db.exec('ALTER TABLE images ADD COLUMN width INTEGER');
if (!imageCols.includes('height')) db.exec('ALTER TABLE images ADD COLUMN height INTEGER');

export default db;
