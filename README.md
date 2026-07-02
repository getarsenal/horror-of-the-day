# 🫣 Horror of the Day

A deliberately **disgusting (but strictly SFW)** daily wallpaper, chosen by
community vote, meant to make you *not* want to be on your phone. Every day the
image changes, so you actively avoid opening your phone lest you meet the new
horror of the day.

> Idea: like a "Wikipedia Picture of the Day," but the community votes for the
> most revolting SFW image, and you set it as your phone wallpaper as a
> deterrent.

## The honest constraint (read this first)

**No App Store app can silently reset your Home Screen wallpaper every day on
its own** — iOS sandboxes that. So the "my phone changed itself overnight"
magic runs through an **Apple Shortcut**: a daily *Automation* + the built-in
**Set Wallpaper** action fetches today's image from this server. Works today,
no jailbreak, no App Store review. The app generates that Shortcut for you —
setup steps are in the app UI and below.

Everything else — voting, the daily "photo of the day" selection, submissions,
moderation, sourcing — is this web app / JSON API.

## What's here

- **Daily selection** — the top community-voted, approved image becomes the
  "Horror of the Day" and stays fixed for the whole calendar day, with a
  cooldown so the same image doesn't repeat on back-to-back days.
- **Community voting** — 👍 "horrifying" / 👎 "not scary enough", one vote per
  browser per image, net-scored leaderboard.
- **Submissions + moderation queue** — anyone can submit an image URL; nothing
  is votable until a human approves it.
- **Wikimedia Commons importer** — pull candidates from curated gross-but-SFW
  categories (deep-sea creatures, parasites, insects, fungi…) straight into the
  moderation queue.
- **Wallpaper endpoint** — `GET /api/wallpaper/today.jpg` 302-redirects to
  today's image bytes, so an iOS Shortcut's "Get Contents of URL" just works.

## Quick start

```bash
npm install
npm run seed          # load the curated starter set (day-one content)
npm start             # http://localhost:3000
```

Optional — pull fresh candidates from Wikimedia Commons into the review queue
(requires outbound network):

```bash
npm run import:wikimedia -- 5   # ~5 images per category
```

### Config

| Env var          | Default          | Purpose                                        |
| ---------------- | ---------------- | ---------------------------------------------- |
| `PORT`           | `3000`           | HTTP port                                      |
| `CH_ADMIN_KEY`   | `dev-admin-key`  | Key for moderation endpoints (set this!)       |
| `CH_DB_PATH`     | `data/horror-of-the-day.db` | SQLite location (`:memory:` for tests) |
| `CH_NIGHTLY`     | *(off)*          | `1` runs the nightly job in-process            |
| `CH_SEED_ON_START` | *(on)*         | `0` disables auto-seeding an empty catalog     |

See **[DEPLOY.md](DEPLOY.md)** for the full env-var list. (The `CH_` prefix is a
legacy short-name from the project's original repo; it's internal only — nobody
you share the app with ever sees it.)

## Deploy it live

The app is meant to be hosted once at a public HTTPS URL; then anyone can open
it on their phone and tap **Download the iOS Shortcut**. It's self-running: the
nightly job feeds the queue and pre-selects each day's horror, and a fresh
database auto-seeds the 8 starter images on first boot.

- **Render** — this repo ships a `render.yaml` blueprint (New → Blueprint →
  pick the repo; it even generates `CH_ADMIN_KEY` for you). Or one-click it:

  [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/getarsenal/horror-of-the-day)
- **Docker / Fly / Railway / VPS** — this repo ships a `Dockerfile` (DB on a
  `/data` volume, nightly job on).

Full step-by-step for each in **[DEPLOY.md](DEPLOY.md)**.

## Share it with friends

You host once; everyone you share with just needs an iPhone. **They never sign
into GitHub, Render, or anything** — hosting is your one-time step, invisible to
them.

1. Deploy (above) to get a public URL, e.g. `https://horror-of-the-day.onrender.com`.
2. Send that link to whoever you want.
3. They open it in **Safari on iPhone** and follow the on-page steps: tap **Add
   the Shortcut**, allow it once, add a daily automation. Done.

Their entire experience is one web page and one button — no App Store, no
account.
## API

Public:

| Method | Path                          | Description                                   |
| ------ | ----------------------------- | --------------------------------------------- |
| GET    | `/api/today`                  | Today's Horror of the Day (auto-selects)      |
| GET    | `/api/wallpaper/today.jpg`    | 302 → today's image bytes (for Shortcuts)     |
| GET    | `/api/ios/shortcut`           | Download a ready-made `.shortcut` (see below) |
| GET    | `/api/config`                 | Frontend config (which shortcut link to use)  |
| GET    | `/api/candidates`             | Approved images, ranked by net vote score     |
| GET    | `/api/history`                | Past days' horrors                            |
| GET    | `/api/stats`                  | Catalog counts                                |
| POST   | `/api/submit`                 | Submit `{title, image_url, ...}` (→ pending)  |
| POST   | `/api/candidates/:id/vote`    | `{voter_token, value: 1 or -1}`               |

Admin (require header `x-admin-key: <CH_ADMIN_KEY>`):

| Method | Path                            | Description                          |
| ------ | ------------------------------- | ------------------------------------ |
| GET    | `/api/moderation/pending`       | List images awaiting review          |
| POST   | `/api/moderation/:id/approve`   | Make an image votable                 |
| POST   | `/api/moderation/:id/reject`    | Hide an image                         |
| POST   | `/api/moderation/import`        | Import from Wikimedia Commons         |

## iOS auto-wallpaper (the deterrent)

### One-tap: download the generated Shortcut

Visit the app in Safari and tap **⬇︎ Download the iOS Shortcut**, or hit
`GET /api/ios/shortcut` directly. The server generates a `.shortcut` whose
"Get Contents of URL" action already points at *your* deployment's
`/api/wallpaper/today.jpg` (the URL is built from the request host) and pipes
it straight into **Set Wallpaper**.

Because Apple only signs shortcuts through its own private service, this is an
**unsigned** shortcut. To import one:

1. Enable **Settings → Shortcuts → Allow Untrusted Shortcuts** (the toggle only
   appears after you've run any one shortcut once).
2. Open the downloaded `.shortcut` file to import it.
3. Add a daily **Automation** (Shortcuts → Automation → Time of Day → **Run
   Immediately**) that runs it, so it fires hands-free every morning.

> The generated shortcut is a standard XML plist validated to parse as an Apple
> property list; the action identifiers (`is.workflow.actions.downloadurl` and
> `is.workflow.actions.wallpaper.set`) should be confirmed on a physical device
> across iOS versions, since Apple occasionally renames actions.

### Manual build (no untrusted-shortcuts toggle needed)

1. **Shortcuts** app → **Automation** → **+** → **Time of Day** → pick a time
   (e.g. 6:00 AM), Daily, **Run Immediately**.
2. Add **Get Contents of URL** → `https://<your-server>/api/wallpaper/today.jpg`
3. Add **Set Wallpaper Photo** → use the downloaded image; turn *off* "Show
   Preview" so it applies silently.

Now every morning your Home & Lock screen becomes the day's new horror. To make
your phone even less inviting, set the automation before your usual wake time.

## Content policy

SFW only: disturbing, gross, unsettling — **nothing sexual or graphically
violent**. Imported and submitted images always pass through the human
moderation queue before they can be voted on or featured. Images from Wikimedia
Commons carry their source link and credit/license.

## Project layout

```
src/
  db.js          SQLite schema + connection
  store.js       Domain logic: submit, vote, leaderboard, daily selection
  wikimedia.js   Wikimedia Commons category importer
  shortcut.js    Generates the unsigned iOS `.shortcut` (plist)
  server.js      Express JSON API + static hosting
  seed.js        Curated starter set (npm run seed)
  import-cli.js  CLI importer (npm run import:wikimedia)
public/          Frontend (vote, submit, setup instructions)
test/            node:test suite for the domain logic
```

## Roadmap

- Downscale/crop imports to iPhone aspect ratios and cache the bytes (own the
  hosting instead of hotlinking Commons)
- Accounts / rate limiting to harden voting against ballot-stuffing
- Signed Shortcut distribution (removes the "Allow Untrusted Shortcuts" step)

## Tests

```bash
npm test
```

## License

MIT
