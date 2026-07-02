import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.CH_DB_PATH = ':memory:';

let store;
before(async () => {
  store = await import('../src/store.js');
});

const approved = (n) => store.addImage({ title: `img${n}`, image_url: `https://x/${n}.jpg`, status: 'approved' }).id;

test('daily cap: 3 new votes/day, switch/toggle do not consume extra', () => {
  const img = [approved(1), approved(2), approved(3), approved(4)];

  assert.equal(store.vote(img[0], 'z', 1).remaining, 2);
  assert.equal(store.vote(img[1], 'z', 1).remaining, 1);
  assert.equal(store.vote(img[2], 'z', 1).remaining, 0);

  // 4th brand-new vote is blocked.
  assert.throws(() => store.vote(img[3], 'z', 1), /daily vote limit/);

  // Switching an existing vote (👍→👎) is allowed and consumes nothing new.
  const sw = store.vote(img[0], 'z', -1);
  assert.equal(sw.myVote, -1);
  assert.equal(sw.remaining, 0);

  // Toggling one off frees an allowance…
  const off = store.vote(img[1], 'z', 1); // same value → remove
  assert.equal(off.myVote, 0);
  assert.equal(store.votesRemaining('z'), 1);

  // …so a new vote is allowed again.
  assert.equal(store.vote(img[3], 'z', 1).myVote, 1);
});

test('toggle off returns score without that vote', () => {
  const img = approved(10);
  assert.equal(store.vote(img, 'q', 1).score, 1);
  assert.equal(store.vote(img, 'q', 1).score, 0); // toggled off
  assert.equal(store.myVoteMap('q')[img], undefined);
});

test('myVoteMap reflects the voter’s current choices', () => {
  const a = approved(20);
  const b = approved(21);
  store.vote(a, 'w', 1);
  store.vote(b, 'w', -1);
  const map = store.myVoteMap('w');
  assert.equal(map[a], 1);
  assert.equal(map[b], -1);
});
