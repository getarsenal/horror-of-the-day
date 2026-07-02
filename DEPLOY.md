# Deploying Horror of the Day

You host the app **once** at a public HTTPS URL. After that it runs itself: the
nightly job tops up the moderation queue and pre-selects each day's horror, and
a fresh database auto-seeds the 8 starter images on first boot. Then anyone can
open the site on their phone and tap **Download the iOS Shortcut**.

Pick whichever path below fits you. All of them end with a URL like
`https://horror-of-the-day.onrender.com`.

---

## Option A — Render (blueprint, easiest)

The repo ships a `render.yaml`, so Render provisions everything for you.

1. Push this repo to your own GitHub (or fork it).
2. In the [Render dashboard](https://dashboard.render.com): **New → Blueprint**,
   pick the repo. Render reads `render.yaml`, creates the web service, and
   **generates a strong `CH_ADMIN_KEY` for you** automatically.
3. Click **Apply**. First deploy takes a couple minutes (it builds
   better-sqlite3). When it's live, open the service URL.

That's it — the site is public and auto-seeded.

**Persistence:** the free plan uses ephemeral storage, so votes/history reset
whenever the instance restarts (the catalog still auto-seeds, so it always
works). To keep data across redeploys, edit `render.yaml`: set `plan: starter`,
uncomment the `disk:` block and the `CH_DB_PATH` env var, and redeploy.

---

## Option B — Docker (any container host: Fly.io, Railway, a VPS…)

The repo ships a `Dockerfile` that already sets `CH_NIGHTLY=1` and stores the DB
on a `/data` volume.

```bash
docker build -t horror-of-the-day .

docker run -d --name hotd \
  -p 80:3000 \
  -e CH_ADMIN_KEY="$(openssl rand -hex 24)" \
  -v hotd-data:/data \
  horror-of-the-day
```

Put it behind any HTTPS terminator (Caddy, nginx, your host's load balancer,
Cloudflare Tunnel). The `-v hotd-data:/data` volume persists the SQLite DB.

**Fly.io:** `fly launch` detects the Dockerfile; add a volume with
`fly volumes create data --size 1` and a `[mounts]` entry pointing at `/data`,
then `fly secrets set CH_ADMIN_KEY=$(openssl rand -hex 24)`.

---

## Option C — Plain Node host / VPS

```bash
git clone <your-fork> && cd horror-of-the-day
npm ci
export CH_ADMIN_KEY="$(openssl rand -hex 24)"
export CH_NIGHTLY=1                 # in-process nightly job
export CH_DB_PATH=/var/lib/hotd/hotd.db   # somewhere persistent
npm start
```

Run it under a process manager (systemd, pm2) and reverse-proxy HTTPS to
`PORT` (default 3000). If you'd rather drive the nightly job with system cron
instead of the in-process scheduler, leave `CH_NIGHTLY` unset and add:

```cron
15 3 * * *  cd /path/to/horror-of-the-day && /usr/bin/npm run nightly >> /var/log/hotd-nightly.log 2>&1
```

---

## Environment variables

| Var                | Default                     | Purpose                                                    |
| ------------------ | --------------------------- | ---------------------------------------------------------- |
| `PORT`             | `3000`                      | Port to listen on.                                         |
| `CH_ADMIN_KEY`     | `dev-admin-key` (insecure)  | **Set this.** Guards all `/api/moderation/*` routes.       |
| `CH_DB_PATH`       | `data/horror-of-the-day.db` | SQLite file location. Point at a mounted volume to persist.|
| `CH_NIGHTLY`       | *(off)*                     | `1` enables the in-process nightly scheduler.              |
| `CH_NIGHTLY_HOUR`  | `3`                         | UTC hour the nightly job runs.                             |
| `CH_NIGHTLY_IMPORT`| *(on)*                      | `0` disables the Wikimedia import step of the nightly job. |
| `CH_SEED_ON_START` | *(on)*                      | `0` disables auto-seeding an empty catalog on boot.        |
| `CH_SHORTCUT_ICLOUD_URL` | *(unset)*             | A signed iCloud shortcut link. Set it for a zero-settings, one-tap install (see below). |

## Zero-settings install for the people you share with (recommended)

By default the app serves an *unsigned* `.shortcut`, so each recipient has to
flip **Allow Untrusted Shortcuts** once. You can remove that step entirely by
publishing the shortcut as an **Apple-signed iCloud link** — do this once on
your own iPhone and everyone you share with installs it with no settings change:

1. On your iPhone, open your deployed site and add the shortcut once (or build
   it by hand: *Get Contents of URL* → your `/api/wallpaper/today.jpg` →
   *Set Wallpaper*).
2. In the Shortcuts app, long-press the shortcut → **Share** → **Copy iCloud
   Link**. You'll get a URL like `https://www.icloud.com/shortcuts/abc123…`.
3. Set it as an env var and redeploy:
   `CH_SHORTCUT_ICLOUD_URL=https://www.icloud.com/shortcuts/abc123…`

Now the **Add the Shortcut** button points at the signed link and the setup
flow automatically drops the "Allow Untrusted Shortcuts" step. (Verify the link
imports cleanly on a device — Apple occasionally expires iCloud shortcut links,
in which case re-share and update the env var.)

## After it's live

1. Open the URL on an iPhone in Safari → tap **⬇︎ Download the iOS Shortcut**.
2. Enable **Settings → Shortcuts → Allow Untrusted Shortcuts**, then open the
   downloaded file to import it.
3. Add a daily **Automation** (Shortcuts → Automation → Time of Day → Run
   Immediately) that runs it. See the app's setup section or the README for the
   tap-by-tap.

## Health check

`GET /api/health` returns `{"ok":true}` — wire it into your host's health probe
(Render's blueprint already does).
