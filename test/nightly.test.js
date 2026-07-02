import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// Isolated in-memory DB, set before importing store (which opens the DB on load).
process.env.CH_DB_PATH = ':memory:';

let store, nightly;
before(async () => {
  store = await import('../src/store.js');
  nightly = await import('../src/nightly.js');
});

test('tomorrow() returns the UTC day after now', () => {
  assert.equal(nightly.tomorrow(new Date('2026-03-10T12:00:00Z')), '2026-03-11');
  // Crossing a month boundary.
  assert.equal(nightly.tomorrow(new Date('2026-01-31T23:59:00Z')), '2026-02-01');
});

test('runNightly imports into the pending queue and pre-selects tomorrow', async () => {
  // An approved image with a vote so there is something to pre-select.
  const win = store.addImage({ title: 'Winner', image_url: 'https://x/win.jpg', status: 'approved' });
  store.vote(win.id, 'a', 1);

  const fakeImporter = async () => [
    { title: 'New Gross Thing', image_url: 'https://x/new.jpg', source_url: 'https://s', credit: 'c' },
  ];

  const now = new Date('2026-03-10T04:00:00Z');
  const summary = await nightly.runNightly({ now, importer: fakeImporter, dimensionLookup: async () => ({}) });

  // Import landed in the queue as pending (not votable yet — guardrail intact).
  assert.deepEqual(summary.import, { found: 1, added: 1 });
  const pending = store.listByStatus('pending');
  const imported = pending.find((p) => p.image_url === 'https://x/new.jpg');
  assert.ok(imported, 'imported image should be pending');
  assert.equal(imported.submitted_by, 'nightly-import');

  // Tomorrow was pre-selected from approved images only.
  assert.equal(summary.preselected.day, '2026-03-11');
  assert.equal(summary.preselected.id, win.id);
  assert.equal(store.horrorOfTheDay('2026-03-11').id, win.id, 'pre-selection should stick');
});

test('a failing import does not block pre-selection', async () => {
  const win = store.addImage({ title: 'W2', image_url: 'https://x/w2.jpg', status: 'approved' });
  store.vote(win.id, 'a', 1);

  const boom = async () => {
    throw new Error('egress blocked (403)');
  };

  const now = new Date('2026-05-01T04:00:00Z');
  const summary = await nightly.runNightly({ now, importer: boom, dimensionLookup: async () => ({}) });

  assert.equal(summary.import.error, 'egress blocked (403)');
  assert.equal(summary.preselected.day, '2026-05-02');
  assert.ok(summary.preselected.id, 'should still pre-select despite import failure');
});

test('doImport:false skips the import step entirely', async () => {
  const win = store.addImage({ title: 'W3', image_url: 'https://x/w3.jpg', status: 'approved' });
  store.vote(win.id, 'a', 1);

  let called = false;
  const spy = async () => {
    called = true;
    return [];
  };

  const summary = await nightly.runNightly({
    now: new Date('2026-06-01T04:00:00Z'),
    doImport: false,
    importer: spy,
    dimensionLookup: async () => ({}),
  });

  assert.equal(called, false, 'importer must not be called when doImport is false');
  assert.equal(summary.import, null);
  assert.equal(summary.preselected.day, '2026-06-02');
});
