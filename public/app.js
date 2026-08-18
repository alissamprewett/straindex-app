// app.js — shared client-side behavior. No framework, no build step.

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
    btn.textContent = `👏 Kudos (${data.kudos})`;
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
  let selected = [];

  function renderEffects() {
    const atMax = selected.length >= 5;
    searchInput.disabled = atMax;
    searchInput.placeholder = atMax ? 'Max 5 selected — remove one to add another' : 'Search 85+ moods, feelings & relief tags...';
    chipsBox.innerHTML = selected.map(e =>
      `<span class="tag-chip">${e} <button type="button" data-remove="${e}">✕</button></span>`
    ).join('');
    hiddenBox.innerHTML = selected.map(e => `<input type="hidden" name="effects" value="${e}">`).join('');
    noteBox.textContent = `${selected.length} of 5 selected — pick at least 1`;
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

  const form = document.getElementById('checkin-form');
  if (form) {
    form.addEventListener('submit', (evt) => {
      if (selected.length < 1) {
        evt.preventDefault();
        toast('Pick at least 1 mood/effect');
        searchInput.focus();
      }
    });
  }

  renderEffects();

  // Photo capture — read the file as a data URL and stash it in a hidden
  // field so the plain <form> POST carries it; no multipart parsing needed.
  const fileInput = document.getElementById('photo-file-input');
  const photoData = document.getElementById('photo-data-input');
  const uploadBox = document.getElementById('photo-upload-box');
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
