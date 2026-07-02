import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.CH_DB_PATH = ':memory:';

let store, nightly, aspect, wikimedia;
before(async () => {
  store = await import('../src/store.js');
  nightly = await import('../src/nightly.js');
  aspect = await import('../src/aspect.js');
  wikimedia = await import('../src/wikimedia.js');
});

test('isPhoneFriendly accepts portrait/square, rejects landscape and unknown', () => {
  assert.equal(aspect.isPhoneFriendly(800, 1200), true); // portrait
  assert.equal(aspect.isPhoneFriendly(1000, 1000), true); // square
  assert.equal(aspect.isPhoneFriendly(1200, 800), false); // landscape
  assert.equal(aspect.isPhoneFriendly(null, null), false); // unmeasured
  assert.equal(aspect.isPhoneFriendly(1000, 999), false); // barely landscape
});

test('horrorOfTheDay prefers a portrait image over a higher-scored landscape', () => {
  const land = store.addImage({ title: 'Wide', image_url: 'https://x/wide.jpg', status: 'approved', width: 1600, height: 900 });
  const port = store.addImage({ title: 'Tall', image_url: 'https://x/tall.jpg', status: 'approved', width: 900, height: 1600 });
  // Landscape has the higher raw score...
  store.vote(land.id, 'a', 1);
  store.vote(land.id, 'b', 1);
  store.vote(port.id, 'c', 1);
  // ...but the portrait one should still be chosen because it fits a phone.
  const pick = store.horrorOfTheDay('2027-01-01');
  assert.equal(pick.id, port.id);
});

test('falls back to landscape when no portrait image exists', () => {
  // Clear out any approved images from earlier tests so only landscape remains.
  for (const img of store.leaderboard(200)) store.setStatus(img.id, 'rejected');
  const only = store.addImage({ title: 'OnlyWide', image_url: 'https://y/ow.jpg', status: 'approved', width: 1600, height: 900 });
  store.vote(only.id, 'a', 1);
  const pick = store.horrorOfTheDay('2027-02-01');
  assert.equal(pick.id, only.id);
});

test('fileTitleFromUrl derives a normalized Commons title from stored URLs', () => {
  assert.equal(
    wikimedia.fileTitleFromUrl('https://commons.wikimedia.org/wiki/Special:FilePath/Wolf_spider_with_young.jpg'),
    'File:Wolf spider with young.jpg'
  );
  assert.equal(
    wikimedia.fileTitleFromUrl('https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Tick_male_(aka).jpg/1290px-Tick_male_(aka).jpg'),
    'File:Tick male (aka).jpg'
  );
  assert.equal(wikimedia.fileTitleFromUrl('https://example.com/not-commons.jpg'), null);
});

test('backfillDimensions measures unmeasured images via the injected lookup', async () => {
  // Two images with no dimensions yet.
  const a = store.addImage({ title: 'A', image_url: 'https://commons.wikimedia.org/wiki/Special:FilePath/A_thing.jpg', status: 'approved' });
  store.addImage({ title: 'B', image_url: 'https://commons.wikimedia.org/wiki/Special:FilePath/B_thing.jpg', status: 'approved' });
  assert.ok(store.imagesMissingDimensions().length >= 2);

  const lookup = async (titles) => {
    const out = {};
    for (const t of titles) {
      if (t === 'File:A thing.jpg') out[t] = { width: 900, height: 1600 };
      if (t === 'File:B thing.jpg') out[t] = { width: 1600, height: 900 };
    }
    return out;
  };

  const result = await nightly.backfillDimensions({ lookup });
  assert.equal(result.measured, 2);
  assert.equal(store.getImage(a.id).width, 900);
  assert.equal(store.getImage(a.id).height, 1600);
});
