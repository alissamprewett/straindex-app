// app.js — shared client-side behavior. No framework, no build step.

// Timestamps are stored and sent as UTC. Formatting them server-side would
// bake in the *server's* timezone for every viewer, which isn't what anyone
// wants — each person should see the time converted to their own device's
// local timezone. So the server only sends the raw UTC value (in a data
// attribute) and this runs in the viewer's own browser to fill in the
// human-readable local version.
(function renderLocalTimes() {
  function apply() {
    document.querySelectorAll('.local-time[data-utc]').forEach(el => {
      const d = new Date(el.dataset.utc);
      if (isNaN(d.getTime())) return;
      el.textContent = d.toLocaleString();
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', apply);
  } else {
    apply();
  }
})();

function toast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

function toggleFaq(el) {
  el.parentElement.classList.toggle('open');
}

async function giveKudos(id, btn) {
  const res = await fetch(`/api/recipes/${id}/kudos`, { method: 'POST' });
  if (res.ok) {
    const data = await res.json();
    const icon = btn.querySelector('img, svg');
    btn.innerHTML = (icon ? icon.outerHTML : '') + `Kudos (${data.kudos})`;
    btn.disabled = true;
    toast('Kudos given!');
  }
}

async function likeGrowTip(id, btn) {
  const res = await fetch(`/api/growtips/${id}/like`, { method: 'POST' });
  if (res.ok) {
    const data = await res.json();
    btn.textContent = `👍 Helpful (${data.likes})`;
    btn.disabled = true;
  }
}

// ------------------------------------------------------------ strain search
// Live search on /strains — fetches /api/strains as you type instead of
// resubmitting the whole page on every keystroke (which used to reload the
// page and kick focus out of the search box after each letter).
(function initStrainSearch() {
  const input = document.getElementById('strain-search-input');
  const resultsEl = document.getElementById('strain-search-results');
  const countEl = document.getElementById('strain-search-count');
  if (!input || !resultsEl || !countEl) return;

  const typeVal = document.getElementById('strain-search-type').value;
  const rarityVal = document.getElementById('strain-search-rarity').value;
  const effectVal = document.getElementById('strain-search-effect').value;
  const thcVal = document.getElementById('strain-search-thc').value;
  const terpeneVal = document.getElementById('strain-search-terpene').value;
  const ailmentVal = document.getElementById('strain-search-ailment').value;

  function escHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const rarityLabels = { common: 'Common', uncommon: 'Uncommon', rare: 'Rare', legendary: 'Legendary' };
  function rarityLabel(r) { return rarityLabels[r] || r; }

  function render(data) {
    countEl.textContent = data.total > 60
      ? `Showing 60 of ${data.total.toLocaleString()} — refine your search to narrow it down.`
      : `${data.total} strain${data.total === 1 ? '' : 's'}`;
    resultsEl.innerHTML = data.results.map(s => `
      <a class="library-row" href="/strains/${s.id}" style="text-decoration:none;color:inherit;">
        <span class="icon">${s.icon}</span>
        <div class="info">
          <div class="nm">${escHtml(s.name)}</div>
          <div class="sub">${escHtml(s.type)} · ${rarityLabel(s.rarity)} · THC ${escHtml(s.thc)}</div>
        </div>
        <span class="rarity-tag rarity-${s.rarity}">${rarityLabel(s.rarity)}</span>
      </a>`).join('') || `<div class="empty-note">No strains match your filters.</div>`;
  }

  let debounceTimer;
  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const q = input.value;
    debounceTimer = setTimeout(async () => {
      const params = new URLSearchParams({ q, type: typeVal, rarity: rarityVal, effect: effectVal, thc: thcVal, terpene: terpeneVal, ailment: ailmentVal, limit: '60' });
      const res = await fetch(`/api/strains?${params}`);
      if (!res.ok) return;
      render(await res.json());
      // Keep the URL in sync (so refresh/back/share still works) without navigating.
      history.replaceState(null, '', `/strains?${params}`);
    }, 200);
  });
})();

// ------------------------------------------------------------ dispensaries
// "Use my location" button on /dispensaries — asks the browser for GPS
// coordinates, then reloads the page with ?lat=&lon= so the server can look
// up real nearby dispensaries (see lib/geodispensaries.js).
(function initLocateDispensaries() {
  const btn = document.getElementById('use-location-btn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (!navigator.geolocation) { toast('Location is not supported on this device'); return; }
    btn.disabled = true;
    btn.textContent = 'Finding you…';
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        window.location.href = `/dispensaries?lat=${latitude}&lon=${longitude}`;
      },
      (err) => {
        toast(err && err.code === 1 ? 'Location permission denied' : 'Could not get your location');
        btn.disabled = false;
        btn.textContent = 'Use my location';
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
    );
  });
})();

// Register the service worker for installability (PWA "Add to Home Screen").
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

// ---------------------------------------------------------------- check-in: strain picker
// Live strain search for /checkin — same idea as the effect picker above,
// but fetches real matches from /api/strains instead of a fixed vocab list,
// so it scales past whatever a <datalist> can reasonably hold.
(function initStrainPicker() {
  const picker = document.getElementById('strain-picker');
  const searchInput = document.getElementById('strain-picker-search');
  const resultsBox = document.getElementById('strain-picker-results');
  const selectedBox = document.getElementById('strain-picker-selected');
  const hiddenInput = document.getElementById('strain-picker-hidden');
  const hintBox = document.getElementById('strain-picker-hint');
  const changeBtn = document.getElementById('strain-picker-change');
  if (!picker || !searchInput) return;

  function escHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function selectStrain(s) {
    hiddenInput.value = s.id;
    selectedBox.innerHTML = `${s.icon} <b>${escHtml(s.name)}</b> <button type="button" id="strain-picker-change" class="btn secondary" style="float:right;padding:2px 10px;">Change</button>`;
    selectedBox.style.display = '';
    picker.style.display = 'none';
    hintBox.style.display = 'none';
    document.getElementById('strain-picker-change').onclick = clearSelection;
  }
  function clearSelection() {
    hiddenInput.value = '';
    selectedBox.style.display = 'none';
    picker.style.display = '';
    hintBox.style.display = '';
    searchInput.value = '';
    searchInput.focus();
  }
  if (changeBtn) changeBtn.onclick = clearSelection;

  let debounceTimer;
  searchInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const q = searchInput.value.trim();
    if (!q) { resultsBox.classList.remove('open'); resultsBox.innerHTML = ''; return; }
    debounceTimer = setTimeout(async () => {
      const res = await fetch(`/api/strains?${new URLSearchParams({ q, limit: '8' })}`);
      if (!res.ok) return;
      const data = await res.json();
      resultsBox.innerHTML = data.results.length
        ? data.results.map(s => `<div class="search-result-row" data-id="${s.id}">${s.icon} ${escHtml(s.name)} <span class="empty-note" style="padding:0;">— ${escHtml(s.type)}</span></div>`).join('')
        : `<div class="search-no-results">No matches — try a different spelling, or <a href="/strains">browse the library</a>.</div>`;
      resultsBox.classList.add('open');
      resultsBox.querySelectorAll('[data-id]').forEach(row => {
        row.onclick = () => {
          const match = data.results.find(s => s.id === row.dataset.id);
          if (match) selectStrain(match);
          resultsBox.classList.remove('open');
        };
      });
    }, 200);
  });
})();

// ---------------------------------------------------------------- check-in
// Mood/effects search picker (pick 1-5) and photo capture, used on /checkin.
// window.EFFECT_VOCAB is inlined by the server on that page only.
(function initCheckinForm() {
  const picker = document.getElementById('effect-picker');
  if (!picker || !window.EFFECT_VOCAB) return;

  const searchInput = document.getElementById('effect-search');
  const resultsBox = document.getElementById('effect-results');
  const chipsBox = document.getElementById('effect-chips');
  const noteBox = document.getElementById('effect-note');
  const hiddenBox = document.getElementById('effect-hidden-inputs');
  const submitBtn = document.getElementById('checkin-submit');
  let selected = Array.isArray(window.INITIAL_EFFECTS) ? window.INITIAL_EFFECTS.slice(0, 5) : [];

  function renderEffects() {
    const atMax = selected.length >= 5;
    searchInput.disabled = atMax;
    searchInput.placeholder = atMax ? 'Max 5 selected — remove one to add another' : 'Search 85+ moods, feelings & relief tags...';
    chipsBox.innerHTML = selected.map(e =>
      `<span class="tag-chip">${e} <button type="button" data-remove="${e}">✕</button></span>`
    ).join('');
    hiddenBox.innerHTML = selected.map(e => `<input type="hidden" name="effects" value="${e}">`).join('');
    noteBox.textContent = `${selected.length} of 5 selected`;
    noteBox.classList.toggle('full', atMax);
    chipsBox.querySelectorAll('button[data-remove]').forEach(btn => {
      btn.onclick = () => { selected = selected.filter(x => x !== btn.dataset.remove); renderEffects(); };
    });
  }

  function showResults(query) {
    const q = query.trim().toLowerCase();
    if (!q) { resultsBox.classList.remove('open'); resultsBox.innerHTML = ''; return; }
    const matches = window.EFFECT_VOCAB.filter(e => !selected.includes(e) && e.toLowerCase().includes(q)).slice(0, 8);
    resultsBox.innerHTML = matches.length
      ? matches.map(e => `<div class="search-result-row" data-add="${e}">${e}</div>`).join('')
      : `<div class="search-no-results">No matches</div>`;
    resultsBox.classList.add('open');
    resultsBox.querySelectorAll('[data-add]').forEach(row => {
      row.onclick = () => {
        if (selected.length >= 5) return;
        selected.push(row.dataset.add);
        searchInput.value = '';
        resultsBox.classList.remove('open');
        renderEffects();
      };
    });
  }

  searchInput.addEventListener('input', () => showResults(searchInput.value));
  searchInput.addEventListener('focus', () => showResults(searchInput.value));
  document.addEventListener('click', (e) => {
    if (!picker.contains(e.target)) resultsBox.classList.remove('open');
  });

  renderEffects();

  // Photo capture — read the file as a data URL and stash it in a hidden
  // field so the plain <form> POST carries it; no multipart parsing needed.
  const fileInput = document.getElementById('photo-file-input');
  const photoData = document.getElementById('photo-data-input');
  const uploadBox = document.getElementById('photo-upload-box');
  if (photoData && window.INITIAL_PHOTO) {
    photoData.value = window.INITIAL_PHOTO;
    uploadBox.innerHTML = `<div class="photo-preview-wrap"><img src="${window.INITIAL_PHOTO}" alt="Your photo"><button type="button" id="clear-photo-btn">✕</button></div>`;
    document.getElementById('clear-photo-btn').onclick = (e) => {
      e.stopPropagation();
      photoData.value = '';
      uploadBox.innerHTML = `<div class="up-ic">📷</div><div class="up-txt">Tap to snap or upload a photo of your bud<br>(optional — we'll show a placeholder if you skip it)</div>`;
    };
  }
  if (fileInput) {
    fileInput.addEventListener('change', () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        photoData.value = reader.result;
        uploadBox.innerHTML = `<div class="photo-preview-wrap"><img src="${reader.result}" alt="Your photo"><button type="button" id="clear-photo-btn">✕</button></div>`;
        document.getElementById('clear-photo-btn').onclick = (e) => {
          e.stopPropagation();
          photoData.value = '';
          fileInput.value = '';
          uploadBox.innerHTML = `<div class="up-ic">📷</div><div class="up-txt">Tap to snap or upload a photo of your bud<br>(optional — we'll show a placeholder if you skip it)</div>`;
        };
      };
      reader.readAsDataURL(file);
    });
  }
})();
