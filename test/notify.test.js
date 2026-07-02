import test from 'node:test';
import assert from 'node:assert/strict';
import { ntfyConfig, notifySubmission } from '../src/notify.js';

test('ntfyConfig is null without a topic, and builds the URL with one', () => {
  assert.equal(ntfyConfig({}), null);
  assert.deepEqual(ntfyConfig({ CH_NTFY_TOPIC: 'abc' }), { url: 'https://ntfy.sh/abc' });
  assert.deepEqual(
    ntfyConfig({ CH_NTFY_TOPIC: 'abc', CH_NTFY_SERVER: 'https://push.example.com/' }),
    { url: 'https://push.example.com/abc' }
  );
});

test('notifySubmission no-ops when ntfy is not configured', async () => {
  let called = false;
  const r = await notifySubmission(
    { title: 'x' },
    { config: null, fetchImpl: async () => ((called = true), { ok: true }) }
  );
  assert.equal(r.sent, false);
  assert.equal(called, false);
});

test('notifySubmission POSTs title in body with Click/Attach headers', async () => {
  let captured;
  const fetchImpl = async (url, opts) => {
    captured = { url, opts };
    return { ok: true, status: 200 };
  };
  const r = await notifySubmission(
    { title: 'Botfly larva', imageUrl: 'https://host/api/images/abc.png', adminUrl: 'https://host/admin.html' },
    { config: { url: 'https://ntfy.sh/secret-topic' }, fetchImpl }
  );
  assert.equal(r.sent, true);
  assert.equal(captured.url, 'https://ntfy.sh/secret-topic');
  assert.equal(captured.opts.method, 'POST');
  assert.match(captured.opts.body, /Botfly larva/);
  assert.equal(captured.opts.headers.Click, 'https://host/admin.html');
  assert.equal(captured.opts.headers.Attach, 'https://host/api/images/abc.png');
});

test('notifySubmission reports a failure instead of throwing', async () => {
  const fetchImpl = async () => {
    throw new Error('network down');
  };
  const r = await notifySubmission({ title: 'x' }, { config: { url: 'https://ntfy.sh/t' }, fetchImpl });
  assert.equal(r.sent, false);
  assert.equal(r.reason, 'network down');
});
