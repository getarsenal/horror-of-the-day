// Control Room for Horror of the Day. Holds the admin key in this browser only
// and drives the /api/moderation/* endpoints.

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

async function loadAll() {
  if (!adminKey) return;
  try {
    const [overview, pending] = await Promise.all([
      api('/api/moderation/overview'),
      api('/api/moderation/pending'),
    ]);
    setKeyMsg('Key accepted.', true);
    $('#dashboard').hidden = false;
    renderTiles(overview);
    renderFeatures(overview);
    renderTrends(overview.trends);
    renderLeaderboard(overview.leaderboard);
    renderPending(pending.pending);
  } catch (err) {
    setKeyMsg(err.message, false);
    $('#dashboard').hidden = true;
  }
}

// --- Stat tiles ------------------------------------------------------------
function renderTiles(o) {
  const tiles = [
    ['Page views', o.metrics.pageViewsTotal, '👁️'],
    ['Wallpaper fetches', o.metrics.wallpaperFetchesTotal, '📱', 'active phones'],
    ['Total votes', o.counts.total_votes, '🗳️'],
    ['Days featured', o.counts.days_featured, '📅'],
    ['Approved', o.counts.approved, '✅'],
    ['Pending', o.counts.pending, '⏳'],
  ];
  $('#tiles').innerHTML = tiles
    .map(([label, val, icon, sub]) => `
      <div class="tile-stat">
        <div class="tile-icon">${icon}</div>
        <div class="tile-val">${Number(val).toLocaleString()}</div>
        <div class="tile-label">${esc(label)}${sub ? ` <span class="muted">· ${esc(sub)}</span>` : ''}</div>
      </div>`)
    .join('');
}

// --- Today / tomorrow ------------------------------------------------------
function renderFeatures(o) {
  $('#features').innerHTML = [featureCard('today', o.today), featureCard('tomorrow', o.tomorrow)].join('');
  $('#features').querySelectorAll('[data-clear]').forEach((b) =>
    b.addEventListener('click', () => selectDay(b.dataset.clear, null))
  );
}

function featureCard(which, data) {
  const h = data.horror;
  const label = which === 'today' ? "Today's Horror" : "Tomorrow's Horror";
  const preview = h
    ? `<div class="phone"><img src="${esc(h.image_url)}" alt="" referrerpolicy="no-referrer" /></div>`
    : `<div class="phone empty">no pick yet<br /><span class="muted small">auto-selects on first view</span></div>`;
  return `
    <div class="feature">
      <div class="feature-h">${label} <span class="muted small">· ${esc(data.day)}</span></div>
      ${preview}
      <div class="feature-t">${h ? esc(h.title) : '—'}</div>
      ${h ? `<button class="btn btn-ghost btn-sm" data-clear="${which}">Clear (auto-pick)</button>` : ''}
    </div>`;
}

// --- Trends (tiny CSS bar charts) ------------------------------------------
function renderTrends(trends) {
  const charts = [
    ['Page views', trends.pageViews, 'var(--accent)'],
    ['Wallpaper fetches', trends.wallpaperFetches, '#7db8ff'],
    ['Votes', trends.votes, '#e0a54f'],
    ['Submissions', trends.submissions, '#c98bff'],
  ];
  $('#trends').innerHTML = charts.map(([label, series, color]) => barChart(label, series, color)).join('');
}

function barChart(label, series, color) {
  const max = Math.max(1, ...series.map((d) => d.count));
  const total = series.reduce((s, d) => s + d.count, 0);
  const bars = series
    .map((d) => `<div class="bar" style="height:${Math.round((d.count / max) * 100)}%;background:${color}" title="${d.day}: ${d.count}"></div>`)
    .join('');
  return `
    <div class="chart">
      <div class="chart-h">${esc(label)} <span class="muted">· ${total.toLocaleString()}</span></div>
      <div class="bars">${bars}</div>
    </div>`;
}

// --- Leaderboard -----------------------------------------------------------
function renderLeaderboard(rows) {
  $('#lb-count').textContent = `· ${rows.length}`;
  if (!rows.length) {
    $('#leaderboard').innerHTML = '<p class="muted">No approved images yet.</p>';
    return;
  }
  $('#leaderboard').innerHTML = rows
    .map((r, i) => `
      <div class="lb-row">
        <div class="lb-rank">${i + 1}</div>
        <img class="lb-thumb" src="${esc(r.image_url)}" alt="" referrerpolicy="no-referrer" />
        <div class="lb-main">
          <div class="lb-title">${esc(r.title)}</div>
          <div class="muted small">score ${r.score ?? 0} · 👍 ${r.upvotes ?? 0} · 👎 ${r.downvotes ?? 0}${r.phone_friendly === false ? ' · ▭ landscape' : ''}</div>
        </div>
        <div class="lb-actions">
          <button class="btn btn-sm" data-today="${r.id}">→ Today</button>
          <button class="btn btn-ghost btn-sm" data-tomorrow="${r.id}">→ Tomorrow</button>
          <button class="btn btn-ghost btn-sm danger" data-reset="${r.id}">Reset votes</button>
        </div>
      </div>`)
    .join('');
  const lb = $('#leaderboard');
  lb.querySelectorAll('[data-today]').forEach((b) => b.addEventListener('click', () => selectDay('today', Number(b.dataset.today))));
  lb.querySelectorAll('[data-tomorrow]').forEach((b) => b.addEventListener('click', () => selectDay('tomorrow', Number(b.dataset.tomorrow))));
  lb.querySelectorAll('[data-reset]').forEach((b) => b.addEventListener('click', () => resetVotes(Number(b.dataset.reset), b)));
}

// --- Pending queue ---------------------------------------------------------
function renderPending(pending) {
  $('#pending-count').textContent = `· ${pending.length}`;
  const wrap = $('#queue');
  if (!pending.length) {
    wrap.innerHTML = '<p class="muted">Queue is empty — nothing waiting. 🎉</p>';
    return;
  }
  const fit = (p) =>
    p.phone_friendly === true ? '<span class="badge ok">📱 fits</span>'
    : p.phone_friendly === false ? '<span class="badge warn">▭ landscape</span>'
    : '<span class="badge">? size</span>';
  wrap.innerHTML = pending
    .map((img) => `
      <div class="tile" data-id="${img.id}">
        <img src="${esc(img.image_url)}" alt="${esc(img.title)}" loading="lazy" referrerpolicy="no-referrer" />
        <div class="body">
          <div class="t-title">${esc(img.title)}</div>
          <div class="muted small">${fit(img)}${img.credit ? ` · ${esc(img.credit)}` : ''}</div>
          ${img.source_url ? `<a href="${esc(img.source_url)}" target="_blank" rel="noopener">source ↗</a>` : ''}
          <div class="mod-row">
            <button class="btn btn-approve" data-approve="${img.id}">✓ Approve</button>
            <button class="btn btn-ghost btn-reject" data-reject="${img.id}">✕ Reject</button>
          </div>
        </div>
      </div>`)
    .join('');
  wrap.querySelectorAll('[data-approve]').forEach((b) => b.addEventListener('click', () => decide(b.dataset.approve, 'approve')));
  wrap.querySelectorAll('[data-reject]').forEach((b) => b.addEventListener('click', () => decide(b.dataset.reject, 'reject')));
}

// --- Actions ---------------------------------------------------------------
async function selectDay(day, imageId) {
  try {
    await api('/api/moderation/select', { method: 'POST', body: JSON.stringify({ day, image_id: imageId }) });
    await loadAll();
  } catch (err) {
    setKeyMsg(err.message, false);
  }
}

async function resetVotes(id, btn) {
  if (!confirm('Wipe all votes for this image?')) return;
  btn.disabled = true;
  try {
    await api(`/api/moderation/${id}/reset-votes`, { method: 'POST' });
    await loadAll();
  } catch (err) {
    setKeyMsg(err.message, false);
    btn.disabled = false;
  }
}

async function decide(id, action) {
  try {
    await api(`/api/moderation/${id}/${action}`, { method: 'POST' });
    await loadAll();
  } catch (err) {
    setKeyMsg(err.message, false);
  }
}

$('#save-key').addEventListener('click', () => {
  adminKey = $('#admin-key').value.trim();
  localStorage.setItem('ch_admin_key', adminKey);
  loadAll();
});
$('#refresh-all').addEventListener('click', loadAll);

$('#import').addEventListener('click', async (e) => {
  const btn = e.target;
  btn.disabled = true;
  btn.textContent = 'Importing…';
  try {
    const r = await api('/api/moderation/import', { method: 'POST', body: JSON.stringify({ perCategory: 5 }) });
    setKeyMsg(`Imported ${r.added} new candidate(s).`, true);
    await loadAll();
  } catch (err) {
    setKeyMsg(err.message, false);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Import from Commons';
  }
});

$('#test-notify').addEventListener('click', async () => {
  try {
    await api('/api/moderation/test-notify', { method: 'POST' });
    setKeyMsg('Test push sent — check your phone.', true);
  } catch (err) {
    setKeyMsg(err.message, false);
  }
});

if (adminKey) loadAll();
