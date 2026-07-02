import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.CH_DB_PATH = ':memory:';

let store;
before(async () => {
  store = await import('../src/store.js');
});

test('metrics count and series (zero-filled) work', () => {
  store.recordMetric('page_view');
  store.recordMetric('page_view');
  store.recordMetric('wallpaper_fetch');
  assert.equal(store.metricTotal('page_view'), 2);
  assert.equal(store.metricTotal('wallpaper_fetch'), 1);

  const series = store.metricSeries('page_view', 14);
  assert.equal(series.length, 14);
  assert.equal(series.at(-1).day, store.today());
  assert.equal(series.at(-1).count, 2); // today
  assert.equal(series[0].count, 0); // 13 days ago, no data
});

test('admin can override and clear the featured image for a day', () => {
  const a = store.addImage({ title: 'A', image_url: 'https://x/a.jpg', status: 'approved', width: 900, height: 1600 });
  const b = store.addImage({ title: 'B', image_url: 'https://x/b.jpg', status: 'approved', width: 900, height: 1600 });
  // Auto-pick would choose one; force B for today.
  store.setSelection(store.today(), b.id);
  assert.equal(store.selectionFor(store.today()).id, b.id);
  // Override to A.
  store.setSelection(store.today(), a.id);
  assert.equal(store.selectionFor(store.today()).id, a.id);
  // Clear → no selection until re-picked.
  store.setSelection(store.today(), null);
  assert.equal(store.selectionFor(store.today()), undefined);
});

test('cannot feature an unapproved image', () => {
  const p = store.addImage({ title: 'Pend', image_url: 'https://x/p.jpg' }); // pending
  assert.throws(() => store.setSelection(store.today(), p.id), /approved/);
});

test('resetVotes clears an image\'s votes', () => {
  const img = store.addImage({ title: 'V', image_url: 'https://x/v.jpg', status: 'approved' });
  store.vote(img.id, 'a', 1);
  store.vote(img.id, 'b', 1);
  assert.equal(store.scoreFor(img.id), 2);
  const removed = store.resetVotes(img.id);
  assert.equal(removed, 2);
  assert.equal(store.scoreFor(img.id), 0);
});

test('votesPerDay / submissionsPerDay return dense series', () => {
  const v = store.votesPerDay(7);
  assert.equal(v.length, 7);
  assert.equal(v.at(-1).day, store.today());
  const s = store.submissionsPerDay(7);
  assert.equal(s.length, 7);
});
