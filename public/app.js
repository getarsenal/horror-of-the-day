// Horror of the Day frontend — talks to the JSON API in src/server.js.

// A stable per-browser voter token so votes can be de-duplicated without login.
const voterToken = (() => {
  let t = localStorage.getItem('ch_voter_token');
  if (!t) {
    t = 'v_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('ch_voter_token', t);
  }
  return t;
})();

// Vote state — the server is authoritative (keyed by voter_token).
let myVotes = {};          // imageId -> current vote (1 / -1 / 0)
let votesRemaining = null; // votes left today
let dailyLimit = 3;
let nextRefresh = null;    // Date of the next daily refresh
const candidatesById = {}; // imageId -> candidate (for the lightbox)
let currentLightboxId = null;

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function api(path, opts) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// --- Today's horror --------------------------------------------------------
async function loadToday() {
  const el = $('#today-body');
  try {
    const { day, horror, next_refresh } = await api('/api/today');
    nextRefresh = next_refresh ? new Date(next_refresh) : nextRefresh;
    $('#today-date').textContent = `· ${day}`;
    el.innerHTML = `
      <img class="today-img tappable" src="${esc(horror.image_url)}" alt="${esc(horror.title)}" loading="lazy"
           data-lightbox="${horror.id}" data-title="${esc(horror.title)}" data-src="${esc(horror.image_url)}" />
      <div class="today-caption">
        <div class="title">${esc(horror.title)}</div>
        ${horror.source_url ? `<a href="${esc(horror.source_url)}" target="_blank" rel="noopener">source</a>` : ''}
        ${horror.credit ? `<div class="muted">${esc(horror.credit)}</div>` : ''}
      </div>`;
    wireLightboxImages(el);
  } catch (err) {
    el.innerHTML = `<p class="muted">No horror yet — ${esc(err.message)}. Try seeding the catalog.</p>`;
  }
}

// --- Candidates / voting ---------------------------------------------------
async function loadCandidates() {
  const wrap = $('#candidates');
  try {
    const data = await api(`/api/candidates?voter_token=${encodeURIComponent(voterToken)}`);
    if (data.daily_vote_limit != null) dailyLimit = data.daily_vote_limit;
    if (data.votes_remaining != null) votesRemaining = data.votes_remaining;
    myVotes = {};
    for (const c of data.candidates) {
      candidatesById[c.id] = c;
      myVotes[c.id] = c.my_vote ?? 0;
    }
    updateVoteStatus();
    if (!data.candidates.length) {
      wrap.innerHTML = '<p class="muted">No candidates yet. Submit one below!</p>';
      return;
    }
    wrap.innerHTML = data.candidates.map(renderCandidate).join('');
    wrap.querySelectorAll('.vote-row [data-vote]').forEach((btn) =>
      btn.addEventListener('click', () => castVote(Number(btn.dataset.id), Number(btn.dataset.vote)))
    );
    wireLightboxImages(wrap);
  } catch (err) {
    wrap.innerHTML = `<p class="muted">Couldn't load candidates: ${esc(err.message)}</p>`;
  }
}

function renderCandidate(c) {
  const mine = myVotes[c.id] ?? 0;
  return `
    <div class="tile" data-id="${c.id}">
      <img class="tappable" src="${esc(c.image_url)}" alt="${esc(c.title)}" loading="lazy"
           data-lightbox="${c.id}" data-title="${esc(c.title)}" data-src="${esc(c.image_url)}" />
      <div class="body">
        <div class="t-title">${esc(c.title)}</div>
        <div class="vote-row">
          <button class="btn-vote ${mine === 1 ? 'active' : ''}" data-vote="1" data-id="${c.id}" title="Horrifying">👍</button>
          <span class="score" id="score-${c.id}">${c.score ?? 0}</span>
          <button class="btn-vote ${mine === -1 ? 'active' : ''}" data-vote="-1" data-id="${c.id}" title="Not scary enough">👎</button>
        </div>
      </div>
    </div>`;
}

// Cast/switch/toggle a vote. The server toggles off when you re-send the same
// choice, and enforces the daily cap.
async function castVote(id, value) {
  try {
    const r = await api(`/api/candidates/${id}/vote`, {
      method: 'POST',
      body: JSON.stringify({ voter_token: voterToken, value }),
    });
    myVotes[id] = r.my_vote;
    if (r.votes_remaining != null) votesRemaining = r.votes_remaining;
    if (candidatesById[id]) {
      candidatesById[id].score = r.score;
      candidatesById[id].my_vote = r.my_vote;
    }
    applyVoteUI(id, r.score, r.my_vote);
    updateVoteStatus();
  } catch (err) {
    updateVoteStatus(err.message, true);
  }
}

// Reflect a vote everywhere it might be shown (tile + open lightbox).
function applyVoteUI(id, score, mine) {
  const s = document.getElementById(`score-${id}`);
  if (s) s.textContent = score;
  document.querySelectorAll(`.tile[data-id="${id}"] .btn-vote`).forEach((b) =>
    b.classList.toggle('active', Number(b.dataset.vote) === mine)
  );
  if (currentLightboxId === Number(id)) renderLightboxVotes(id);
}

function updateVoteStatus(message, isError) {
  const el = $('#votes-left');
  if (!el) return;
  el.className = `vote-left${isError ? ' err' : ''}`;
  if (message) {
    el.textContent = isError ? `🚫 ${message}` : message;
    return;
  }
  if (votesRemaining == null) {
    el.textContent = '';
  } else if (votesRemaining > 0) {
    el.textContent = `🗳️ ${votesRemaining} of ${dailyLimit} votes left today`;
  } else {
    el.textContent = '🚫 no votes left today — resets at the next refresh';
  }
}

// --- History ---------------------------------------------------------------
async function loadHistory() {
  const wrap = $('#history');
  try {
    const { history } = await api('/api/history');
    wrap.innerHTML = history.length
      ? history.map((h) => `
          <div class="tile">
            <img class="tappable" src="${esc(h.image_url)}" alt="${esc(h.title)}" loading="lazy"
                 data-lightbox="${h.id}" data-title="${esc(h.title)}" data-src="${esc(h.image_url)}" />
            <div class="body">
              <div class="day-badge">${esc(h.day)}</div>
              <div class="t-title">${esc(h.title)}</div>
            </div>
          </div>`).join('')
      : '<p class="muted">No past horrors yet — today is day one.</p>';
    wireLightboxImages(wrap);
  } catch {
    wrap.innerHTML = '';
  }
}

// --- Lightbox (tap any image to enlarge & vote) ----------------------------
function wireLightboxImages(root) {
  root.querySelectorAll('img.tappable').forEach((img) =>
    img.addEventListener('click', () => openLightbox(img.dataset.lightbox, img.dataset.title, img.dataset.src))
  );
}

function openLightbox(id, title, src) {
  currentLightboxId = id ? Number(id) : null;
  $('#lb-img').src = src;
  $('#lb-img').alt = title || '';
  $('#lb-title').textContent = title || '';
  renderLightboxVotes(currentLightboxId);
  $('#lightbox').hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  $('#lightbox').hidden = true;
  currentLightboxId = null;
  document.body.style.overflow = '';
}

// Vote controls inside the lightbox — only for images that are current
// (votable) candidates.
function renderLightboxVotes(id) {
  const box = $('#lb-votes');
  const c = id != null ? candidatesById[id] : null;
  if (!c) {
    box.innerHTML = '<span class="muted small">not open for voting</span>';
    return;
  }
  const mine = myVotes[id] ?? 0;
  box.innerHTML = `
    <button class="btn-vote ${mine === 1 ? 'active' : ''}" data-lb-vote="1" title="Horrifying">👍</button>
    <span class="score" id="lb-score">${c.score ?? 0}</span>
    <button class="btn-vote ${mine === -1 ? 'active' : ''}" data-lb-vote="-1" title="Not scary enough">👎</button>`;
  box.querySelectorAll('[data-lb-vote]').forEach((b) =>
    b.addEventListener('click', () => castVote(id, Number(b.dataset.lbVote)))
  );
  // keep the lightbox score element in sync with applyVoteUI
  const lbScore = document.getElementById('lb-score');
  if (lbScore) lbScore.textContent = c.score ?? 0;
}

// --- Countdown to the next daily refresh -----------------------------------
function computeNextRefresh() {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1, 0, 0, 0, 0));
}

function startCountdown() {
  const el = $('#refresh-timer');
  if (!el) return;
  let reloading = false;
  const tick = () => {
    const target = nextRefresh || computeNextRefresh();
    const ms = target - new Date();
    if (ms <= 0) {
      el.textContent = '⏳ refreshing…';
      if (!reloading) {
        reloading = true;
        nextRefresh = computeNextRefresh();
        Promise.all([loadToday(), loadCandidates(), loadHistory()]).finally(() => (reloading = false));
      }
      return;
    }
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const pad = (x) => String(x).padStart(2, '0');
    el.textContent = `⏱️ next horror in ${pad(h)}:${pad(m)}:${pad(s)}`;
  };
  tick();
  setInterval(tick, 1000);
}

document.querySelectorAll('#lightbox [data-close]').forEach((el) => el.addEventListener('click', closeLightbox));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeLightbox();
});

// --- Submit form -----------------------------------------------------------
$('#submit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#submit-msg');
  const form = e.target;
  const file = form.image.files[0];
  const url = form.image_url.value.trim();

  if (!file && !url) {
    msg.textContent = 'Attach an image file or paste an image link.';
    msg.className = 'msg err';
    return;
  }

  try {
    let res;
    if (file) {
      // Multipart upload — let the browser set the Content-Type boundary.
      const fd = new FormData();
      fd.append('title', form.title.value.trim());
      fd.append('image', file);
      if (form.source_url.value.trim()) fd.append('source_url', form.source_url.value.trim());
      if (form.credit.value.trim()) fd.append('credit', form.credit.value.trim());
      fd.append('submitted_by', voterToken);
      const r = await fetch('/api/submit', { method: 'POST', body: fd });
      res = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(res.error || `Request failed (${r.status})`);
    } else {
      res = await api('/api/submit', {
        method: 'POST',
        body: JSON.stringify({
          title: form.title.value.trim(),
          image_url: url,
          source_url: form.source_url.value.trim() || undefined,
          credit: form.credit.value.trim() || undefined,
          submitted_by: voterToken,
        }),
      });
    }
    msg.textContent = res.message;
    msg.className = 'msg ok';
    form.reset();
  } catch (err) {
    msg.textContent = err.message;
    msg.className = 'msg err';
  }
});

// --- iOS Shortcut setup ----------------------------------------------------
// Recent iOS refuses to import unsigned .shortcut files, so the default flow is
// the manual build. If the host published a signed iCloud link, swap in the
// one-tap install instead.
async function loadSetupConfig() {
  try {
    const cfg = await api('/api/config');
    if (cfg.submissionsEnabled === false) {
      const submit = $('#submit-section');
      if (submit) submit.hidden = true;
    }
    if (cfg.iosShortcutSigned && cfg.iosShortcutUrl) {
      const link = $('#download-shortcut');
      if (link) link.setAttribute('href', cfg.iosShortcutUrl);
      const oneTap = $('#setup-oneTap');
      const manual = $('#setup-manual');
      if (oneTap) oneTap.hidden = false;
      if (manual) manual.hidden = true;
    }
  } catch {
    /* keep the manual build steps (the universal fallback) */
  }
}

// --- Wallpaper URL widget --------------------------------------------------
const wallpaperUrl = `${location.origin}/api/wallpaper/today.jpg`;
$('#wallpaper-url').textContent = wallpaperUrl;
$('#copy-url').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(wallpaperUrl);
    $('#copy-url').textContent = 'Copied!';
    setTimeout(() => ($('#copy-url').textContent = 'Copy URL'), 1500);
  } catch {
    /* clipboard may be blocked; the URL is visible anyway */
  }
});

// Kick everything off.
loadToday().then(startCountdown);
loadCandidates();
loadHistory();
loadSetupConfig();
