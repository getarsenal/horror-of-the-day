// Moderation console for Horror of the Day. Holds the admin key in this
// browser only and calls the /api/moderation/* endpoints with it.

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let adminKey = localStorage.getItem('ch_admin_key') || '';
if (adminKey) $('#admin-key').value = adminKey;

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey, ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function setKeyMsg(text, ok) {
  const el = $('#key-msg');
  el.textContent = text;
  el.className = `msg ${ok ? 'ok' : 'err'}`;
}

async function loadPending() {
  const wrap = $('#queue');
  if (!adminKey) {
    wrap.innerHTML = '<p class="muted">Enter your admin key above to load the queue.</p>';
    return;
  }
  wrap.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const { pending } = await api('/api/moderation/pending');
    setKeyMsg('Key accepted.', true);
    $('#pending-count').textContent = `· ${pending.length}`;
    if (!pending.length) {
      wrap.innerHTML = '<p class="muted">Queue is empty — nothing waiting for review. 🎉</p>';
      return;
    }
    wrap.innerHTML = pending.map(renderItem).join('');
    wrap.querySelectorAll('[data-approve]').forEach((b) => b.addEventListener('click', () => decide(b.dataset.approve, 'approve', b)));
    wrap.querySelectorAll('[data-reject]').forEach((b) => b.addEventListener('click', () => decide(b.dataset.reject, 'reject', b)));
  } catch (err) {
    setKeyMsg(err.message, false);
    wrap.innerHTML = `<p class="muted">Couldn't load: ${esc(err.message)}</p>`;
  }
}

function renderItem(img) {
  const fit =
    img.phone_friendly === true ? '<span class="badge ok">📱 fits phone</span>'
    : img.phone_friendly === false ? '<span class="badge warn">▭ landscape</span>'
    : '<span class="badge">? unmeasured</span>';
  const dims = img.width && img.height ? `${img.width}×${img.height}` : 'size unknown';
  return `
    <div class="tile" data-id="${img.id}">
      <img src="${esc(img.image_url)}" alt="${esc(img.title)}" loading="lazy" referrerpolicy="no-referrer" />
      <div class="body">
        <div class="t-title">${esc(img.title)}</div>
        <div class="muted small">${fit} · ${dims}</div>
        ${img.credit ? `<div class="muted small">${esc(img.credit)}</div>` : ''}
        ${img.source_url ? `<a href="${esc(img.source_url)}" target="_blank" rel="noopener">source ↗</a>` : ''}
        <div class="mod-row">
          <button class="btn btn-approve" data-approve="${img.id}">✓ Approve</button>
          <button class="btn btn-ghost btn-reject" data-reject="${img.id}">✕ Reject</button>
        </div>
      </div>
    </div>`;
}

async function decide(id, action, btn) {
  const tile = btn.closest('.tile');
  tile.style.opacity = '0.5';
  try {
    await api(`/api/moderation/${id}/${action}`, { method: 'POST' });
    tile.remove();
    const remaining = document.querySelectorAll('#queue .tile').length;
    $('#pending-count').textContent = `· ${remaining}`;
    if (!remaining) $('#queue').innerHTML = '<p class="muted">Queue is empty — nothing waiting for review. 🎉</p>';
  } catch (err) {
    tile.style.opacity = '1';
    setKeyMsg(err.message, false);
  }
}

$('#save-key').addEventListener('click', () => {
  adminKey = $('#admin-key').value.trim();
  localStorage.setItem('ch_admin_key', adminKey);
  loadPending();
});

$('#refresh').addEventListener('click', loadPending);

$('#import').addEventListener('click', async () => {
  const btn = $('#import');
  btn.disabled = true;
  btn.textContent = 'Importing…';
  try {
    const r = await api('/api/moderation/import', { method: 'POST', body: JSON.stringify({ perCategory: 5 }) });
    setKeyMsg(`Imported ${r.added} new candidate(s) into the queue.`, true);
    await loadPending();
  } catch (err) {
    setKeyMsg(err.message, false);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Import from Commons';
  }
});

// Auto-load if a key is already saved.
if (adminKey) loadPending();
