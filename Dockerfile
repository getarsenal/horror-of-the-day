# Horror of the Day — production container.
# better-sqlite3 is a native module; the build tools let it compile if a
# prebuilt binary isn't available for the target platform.
FROM node:18-bookworm-slim

ENV NODE_ENV=production

# Build deps for better-sqlite3 (removed after install to keep the image lean).
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for better layer caching.
COPY package*.json ./
RUN npm ci --omit=dev \
  && apt-get purge -y python3 make g++ >/dev/null 2>&1 || true

COPY . .

# Persist the SQLite DB on a mounted volume so votes/history survive redeploys.
ENV PORT=3000
ENV CH_DB_PATH=/data/horror-of-the-day.db
# Hands-off: run the nightly import + pre-select in-process (daily 03:00 UTC).
ENV CH_NIGHTLY=1
VOLUME ["/data"]
EXPOSE 3000

# The app auto-seeds the 8 starter images on first boot if the catalog is empty.
CMD ["node", "src/server.js"]
