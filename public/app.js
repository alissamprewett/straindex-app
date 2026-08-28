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
    btn.classList.add('kudos-pulse');
    toast('Kudos given!');
  }
}

async function giveCheckinKudos(id, btn) {
  const res = await fetch(`/api/checkins/${id}/kudos`, { method: 'POST' });
  if (res.ok) {
    const data = await res.json();
    const icon = btn.querySelector('img, svg');
    btn.innerHTML = (icon ? icon.outerHTML : '') + (data.given ? 'Kudos given' : 'Kudos') + (data.kudos ? ` (${data.kudos})` : '');
    btn.classList.toggle('kudos-given', data.given);
    // Force the pulse animation to restart even if the class is already
    // present from a previous toggle -- simply re-adding a class that's
    // already there doesn't replay a CSS animation on its own.
    btn.classList.remove('kudos-pulse');
    void btn.offsetWidth; // reflow, so the browser treats the next add as new
    if (data.given) {
      btn.classList.add('kudos-pulse');
      toast('Kudos given!');
    } else {
      toast('Kudos removed');
    }
    // Update (or remove) the "who gave kudos" label right under the button.
    const wrap = btn.parentElement;
    if (wrap) {
      let label = wrap.querySelector('.kudos-givers-label');
      if (Array.isArray(data.givers) && data.givers.length) {
        const names = data.givers.slice(0, 3).join(', ');
        const extra = data.givers.length - 3;
        const text = `🌿 ${names}${extra > 0 ? ` and ${extra} more` : ''}`;
        if (!label) {
          label = document.createElement('div');
          label.className = 'empty-note kudos-givers-label';
          label.style.cssText = 'padding:2px 0 0;text-align:right;';
          wrap.appendChild(label);
        }
        label.textContent = text;
      } else if (label) {
        label.remove();
      }
    }
  }
}
async function likeComment(id, btn) {
  const res = await fetch(`/api/comments/${id}/like`, { method: 'POST' });
  if (res.ok) {
    const data = await res.json();
    btn.textContent = (data.liked ? '💚 Liked' : '🤍 Like') + (data.count ? ` (${data.count})` : '');
    btn.style.textDecoration = data.liked ? 'none' : 'underline';
  }
}
async function likeGrowTip(id, btn) {
  const res = await fetch(`/api/growtips/${id}/like`, { method: 'POST' });
  if (res.ok) {
    const data = await res.json();
    const icon = btn.querySelector('img, svg');
    btn.innerHTML = (icon ? icon.outerHTML : '') + `Kudos (${data.likes})`;
    btn.disabled = true;
    toast('Kudos given!');
  }
}

// ------------------------------------------------------------ strain search
// Live search on /strains — fetches /api/strains as you type instead of
// resubmitting the whole page on every keystroke (which used to reload the
// page and kick focus out of the search box after each letter).
(function initOnsetTimers() {
  // Edible onset varies a lot person-to-person, but "give it up to 2 hours,
  // don't redose early" is the safest general guidance. This just turns a
  // stored timestamp into a live "started Xh Ym ago" reminder tied to that.
  function label(minutes) {
    const h = Math.floor(minutes / 60), m = Math.floor(minutes % 60);
    const started = h > 0 ? `${h}h ${m}m ago` : `${m}m ago`;
    if (minutes < 60) return `⏱ Started ${started} — onset can take up to 2 hours. Hold off on more.`;
    if (minutes < 90) return `⏱ Started ${started} — getting close to the usual peak window.`;
    return `⏱ Started ${started} — should be at or past full effect by now.`;
  }
  function apply() {
    document.querySelectorAll('.onset-timer[data-utc]').forEach(el => {
      const d = new Date(el.dataset.utc);
      if (isNaN(d.getTime())) return;
      const minutes = (Date.now() - d.getTime()) / 60000;
      el.textContent = label(Math.max(0, minutes));
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', apply);
  } else {
    apply();
  }
  setInterval(apply, 60000);
})();

(function initStrainSearch() {
  const input = document.getElementById('strain-search-input');
  const resultsEl = document.getElementById('strain-search-results');
  const countEl = document.getElementById('strain-search-count');
  if (!input || !resultsEl || !countEl) return;

  const typeSel = document.getElementById('strain-search-type');
  const raritySel = document.getElementById('strain-search-rarity');
  const effectSel = document.getElementById('strain-search-effect');
  const thcSel = document.getElementById('strain-search-thc');
  const terpeneSel = document.getElementById('strain-search-terpene');
  const ailmentSel = document.getElementById('strain-search-ailment');
  const verifiedSel = document.getElementById('strain-search-verified');
  // No dropdown exists for breeder (it's only reachable by clicking through
  // from the Breeder Guide), but the value still needs to survive later
  // filter changes -- read it once from the current URL and carry it
  // forward manually so it doesn't silently vanish the moment another
  // filter is touched.
  const breederValue = new URLSearchParams(location.search).get('breeder') || 'All';

  function escHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const rarityLabels = { common: 'Common', uncommon: 'Uncommon', rare: 'Rare', legendary: 'Legendary' };
  function rarityLabel(r) { return rarityLabels[r] || r; }
  const verifiedBadges = {
    verified: { icon: '✅', label: 'Verified' },
    partial: { icon: '🔹', label: 'Partially verified' },
    listed: { icon: '⚪', label: 'Listed only' },
  };
  function verifiedTier(s) {
    const hasThc = !!s.thc;
    const hasBreeder = !!s.breeder;
    const hasDetail = !!s.flavor || (Array.isArray(s.terps) && s.terps.length > 0);
    const score = [hasThc, hasBreeder, hasDetail].filter(Boolean).length;
    if (score === 3) return 'verified';
    if (score >= 1) return 'partial';
    return 'listed';
  }

  function render(data) {
    countEl.textContent = data.total > 60
      ? `Showing 60 of ${data.total.toLocaleString()} — refine your search to narrow it down.`
      : `${data.total} strain${data.total === 1 ? '' : 's'}`;
    resultsEl.innerHTML = data.results.map(s => {
      const badge = verifiedBadges[verifiedTier(s)];
      return `
      <a class="library-row" href="/strains/${s.id}" style="text-decoration:none;color:inherit;">
        <span class="icon">${s.icon}</span>
        <div class="info">
          <div class="nm">${escHtml(s.name)} <span title="${escHtml(badge.label)}">${badge.icon}</span></div>
          <div class="sub">${escHtml(s.type)} · ${rarityLabel(s.rarity)} · THC ${escHtml(s.thc)}</div>
        </div>
        <span class="rarity-tag rarity-${s.rarity}">${rarityLabel(s.rarity)}</span>
      </a>`;
    }).join('') || `<div class="empty-note">No strains match your filters.</div>`;
  }

  async function runSearch() {
    const params = new URLSearchParams({
      q: input.value, type: typeSel.value, rarity: raritySel.value, effect: effectSel.value,
      thc: thcSel.value, terpene: terpeneSel.value, ailment: ailmentSel.value,
      verified: verifiedSel ? verifiedSel.value : 'All', breeder: breederValue, limit: '60',
    });
    countEl.textContent = 'Searching…';
    const res = await fetch(`/api/strains?${params}`);
    if (!res.ok) return;
    render(await res.json());
    // Keep the URL in sync (so refresh/back/share still works) without navigating.
    history.replaceState(null, '', `/strains?${params}`);
  }
  let debounceTimer;
  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runSearch, 200);
  });
  [typeSel, raritySel, effectSel, thcSel, terpeneSel, ailmentSel, verifiedSel].forEach(sel => sel && sel.addEventListener('change', runSearch));
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
    resultsBox.innerHTML = `<div class="search-no-results">Searching…</div>`;
    resultsBox.classList.add('open');
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

// Custom tap-to-rate star widget -- replaces what used to be a plain
// <select> showing "★★★★★" as text. A hidden input still carries the
// actual value on submit, so the server-side form handling needed zero
// changes for this.
(function initStarPicker() {
  const picker = document.getElementById('star-picker');
  const hidden = document.getElementById('star-picker-value');
  if (!picker || !hidden) return;
  const stars = Array.from(picker.querySelectorAll('.star-btn'));

  function paint(value) {
    stars.forEach(btn => {
      btn.classList.toggle('filled', Number(btn.dataset.star) <= value);
    });
  }

  stars.forEach(btn => {
    btn.addEventListener('click', () => {
      const value = Number(btn.dataset.star);
      hidden.value = value;
      picker.dataset.value = value;
      paint(value);
    });
    // Live preview on hover for anyone on a real mouse -- has no effect
    // on touch, where there's no hover state to fire.
    btn.addEventListener('mouseenter', () => paint(Number(btn.dataset.star)));
  });
  picker.addEventListener('mouseleave', () => paint(Number(hidden.value)));

  paint(Number(hidden.value));
})();

// ---------------------------------------------------------------- glossary terms
// Tap a dotted-underline term (e.g. "decarb") in a recipe or grow tip to
// see a plain-language definition in a small popover near the word.
// Tap the term again, or tap anywhere else, to dismiss it.
(function initGlossary() {
  let openPopover = null;
  let openTermEl = null;

  function closePopover() {
    if (openPopover) { openPopover.remove(); openPopover = null; openTermEl = null; }
  }

  document.addEventListener('click', (e) => {
    const term = e.target.closest('.glossary-term');
    if (term) {
      if (openTermEl === term) { closePopover(); return; }
      closePopover();
      const def = term.dataset.def || '';
      const bubble = document.createElement('div');
      bubble.className = 'glossary-popover';
      bubble.textContent = def;
      document.body.appendChild(bubble);
      const rect = term.getBoundingClientRect();
      const bubbleWidth = Math.min(280, window.innerWidth - 24);
      bubble.style.width = bubbleWidth + 'px';
      let left = rect.left;
      if (left + bubbleWidth > window.innerWidth - 12) left = window.innerWidth - bubbleWidth - 12;
      if (left < 12) left = 12;
      bubble.style.left = left + 'px';
      bubble.style.top = (rect.bottom + 8) + 'px';
      openPopover = bubble;
      openTermEl = term;
      e.stopPropagation();
    } else if (openPopover && !e.target.closest('.glossary-popover')) {
      closePopover();
    }
  });
})();

// ---------------------------------------------------------------- compare
// Two independent strain search-pickers on one page (/compare), each
// suffixed 'a'/'b' so they don't collide. Same search-as-you-type pattern
// as the check-in strain picker, just parameterized to run twice.
(function initComparePickers() {
  ['a', 'b'].forEach(suffix => {
    const searchInput = document.getElementById('compare-search-' + suffix);
    const resultsBox = document.getElementById('compare-results-' + suffix);
    if (!searchInput || !resultsBox) return;
    function escHtml(str) {
      return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    let debounceTimer;
    searchInput.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      const q = searchInput.value.trim();
      if (!q) { resultsBox.classList.remove('open'); resultsBox.innerHTML = ''; return; }
      resultsBox.innerHTML = `<div class="search-no-results">Searching…</div>`;
      resultsBox.classList.add('open');
      debounceTimer = setTimeout(async () => {
        const res = await fetch(`/api/strains?${new URLSearchParams({ q, limit: '8' })}`);
        if (!res.ok) return;
        const data = await res.json();
        resultsBox.innerHTML = data.results.length
          ? data.results.map(s => `<div class="search-result-row" data-id="${s.id}">${s.icon} ${escHtml(s.name)} <span class="empty-note" style="padding:0;">— ${escHtml(s.type)}</span></div>`).join('')
          : `<div class="search-no-results">No matches — try a different spelling.</div>`;
        resultsBox.classList.add('open');
        resultsBox.querySelectorAll('[data-id]').forEach(row => {
          row.onclick = () => {
            const params = new URLSearchParams(window.location.search);
            params.set(suffix, row.dataset.id);
            window.location.href = '/compare?' + params.toString();
          };
        });
      }, 200);
    });
  });
})();

// ---------------------------------------------------- form submit feedback
// A generic "Saving..." state on any form's submit button the moment it's
// clicked, so a slower connection reads as "working" rather than "did that
// actually register?" -- without needing to touch every individual form.
// Skips forms that opt out (data-no-loading-state) and doesn't fight
// native validation: if required fields are empty, the browser blocks the
// submit event before this ever runs.
// -------------------------------------------------------------- recipe scaling
// Recipes are stored as plain-text ingredient lines ("2-3 tbsp olive oil"),
// not structured {amount, unit, name} data -- restructuring all of them
// would be a real data migration. Instead this parses the leading quantity
// out of each line at scale-time (handles plain numbers, decimals, simple
// fractions, mixed numbers, and ranges like "2-3"), scales just that part,
// and leaves the rest of the line untouched. Lines with no parseable
// leading quantity (e.g. "Salt and pepper to taste") are left as-is.
function formatScaledQty(n) {
  const rounded = Math.round(n * 100) / 100;
  const whole = Math.floor(rounded);
  const frac = rounded - whole;
  const fracMap = [[0.333, '⅓'], [0.25, '¼'], [0.667, '⅔'], [0.5, '½'], [0.75, '¾']];
  for (const [val, sym] of fracMap) {
    if (Math.abs(frac - val) < 0.05) return whole > 0 ? `${whole} ${sym}` : sym;
  }
  if (Math.abs(frac) < 0.05) return String(whole);
  return String(Math.round(rounded * 10) / 10);
}
function scaleIngredientText(text, factor) {
  let m = text.match(/^(\d+)\s+(\d+)\/(\d+)(\s.*)?$/); // mixed number: "1 1/2 cups"
  if (m) return formatScaledQty((parseInt(m[1], 10) + parseInt(m[2], 10) / parseInt(m[3], 10)) * factor) + (m[4] || '');
  m = text.match(/^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)(\s.*)?$/); // range: "2-3 tbsp"
  if (m) return `${formatScaledQty(parseFloat(m[1]) * factor)}-${formatScaledQty(parseFloat(m[2]) * factor)}${m[3] || ''}`;
  m = text.match(/^(\d+)\/(\d+)(\s.*)?$/); // fraction: "1/2 cup"
  if (m) return formatScaledQty((parseInt(m[1], 10) / parseInt(m[2], 10)) * factor) + (m[3] || '');
  m = text.match(/^(\d+(?:\.\d+)?)(\s.*)?$/); // plain number: "2 flour tortillas"
  if (m) return formatScaledQty(parseFloat(m[1]) * factor) + (m[2] || '');
  return text; // no leading quantity found -- leave untouched
}
function scaleRecipe(factor, btn) {
  document.querySelectorAll('#ingredients-list li[data-original]').forEach(li => {
    li.textContent = scaleIngredientText(li.dataset.original, factor);
  });
  document.querySelectorAll('.scale-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
}

(function initFormSubmitFeedback() {
  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement) || form.hasAttribute('data-no-loading-state')) return;
    const btn = form.querySelector('button[type="submit"], input[type="submit"]');
    if (!btn || btn.disabled) return;
    btn.dataset.originalText = btn.tagName === 'INPUT' ? btn.value : btn.innerHTML;
    const label = 'Saving…';
    if (btn.tagName === 'INPUT') btn.value = label; else btn.innerHTML = label;
    btn.disabled = true;
    btn.style.opacity = '0.7';
  });
})();
