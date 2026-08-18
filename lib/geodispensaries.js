// geodispensaries.js — real, live dispensary lookup by GPS coordinates.
//
// Uses OpenStreetMap's free Overpass API (no signup, no API key, no cost) to
// find real cannabis retailers tagged shop=cannabis or amenity=dispensary
// near a given lat/lon. Coverage is crowdsourced (volunteers add/edit OSM
// data), so it's genuinely real but can be spotty in some areas — that's the
// tradeoff of the free option vs. a paid API like Google Places.
//
// This makes an outbound network call, so it only works where the process
// running it has normal internet access (true once deployed on Render; NOT
// true inside the Claude sandbox this was built in, which blocks unlisted
// hosts — that's expected and not a bug).
//
// To switch to Google Places later (better coverage, needs a paid API key):
// replace the body of findNearbyDispensaries() with a call to Places Nearby
// Search (type=dispensary or keyword search), keeping the same return shape
// { ok, results, reason } so nothing else in the app needs to change.

// Race a few independent public Overpass instances at once — these free,
// community-run servers get overloaded and 504/time out fairly often
// (observed directly while building this), so querying several in parallel
// and taking whichever answers first is much more reliable than trying one
// at a time.
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const TIMEOUT_MS = 10000;

class OverpassError extends Error {}

function toRad(deg) { return (deg * Math.PI) / 180; }

// Haversine distance in miles between two lat/lon points.
function distanceMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8; // Earth radius in miles
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function buildAddress(tags) {
  if (!tags) return '';
  const parts = [];
  if (tags['addr:housenumber'] && tags['addr:street']) parts.push(`${tags['addr:housenumber']} ${tags['addr:street']}`);
  else if (tags['addr:street']) parts.push(tags['addr:street']);
  if (tags['addr:city']) parts.push(tags['addr:city']);
  if (tags['addr:state']) parts.push(tags['addr:state']);
  return parts.join(', ');
}

function overpassQuery(lat, lon, radiusMeters) {
  return `[out:json][timeout:20];(
    node["shop"="cannabis"](around:${radiusMeters},${lat},${lon});
    way["shop"="cannabis"](around:${radiusMeters},${lat},${lon});
    node["amenity"="dispensary"](around:${radiusMeters},${lat},${lon});
    way["amenity"="dispensary"](around:${radiusMeters},${lat},${lon});
  );out center 25;`;
}

async function runQueryAt(url, lat, lon, radiusMeters) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json, text/plain, */*',
        // Overpass's usage policy asks for a descriptive User-Agent with
        // contact info; some deployments also reject requests that look
        // like anonymous bot traffic without one.
        'User-Agent': 'StrainDexApp/1.0 (contact: alissa.m.prewett@gmail.com)',
      },
      body: 'data=' + encodeURIComponent(overpassQuery(lat, lon, radiusMeters)),
      signal: controller.signal,
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      console.error(`[geodispensaries] ${url} returned ${res.status}: ${bodyText.slice(0, 300)}`);
      throw new OverpassError(`OpenStreetMap lookup returned an error (status ${res.status}).`);
    }
    const data = await res.json();
    return data.elements || [];
  } catch (err) {
    if (err instanceof OverpassError) throw err;
    console.error(`[geodispensaries] ${url} fetch failed:`, err.message || err);
    if (err.name === 'AbortError') throw new OverpassError('The dispensary lookup timed out.');
    throw new OverpassError('Could not reach the dispensary lookup service.');
  } finally {
    clearTimeout(timer);
  }
}

// Races every known Overpass instance at once, returning as soon as the
// first one succeeds. Only fails if ALL of them fail.
async function runQuery(lat, lon, radiusMeters) {
  try {
    const elements = await Promise.any(OVERPASS_ENDPOINTS.map(url => runQueryAt(url, lat, lon, radiusMeters)));
    return { ok: true, elements };
  } catch (aggregateErr) {
    const reason = (aggregateErr.errors && aggregateErr.errors[0] && aggregateErr.errors[0].message)
      || 'Could not reach the dispensary lookup service.';
    return { ok: false, reason };
  }
}

// Returns { ok: true, results: [...] } or { ok: false, reason: string }
async function findNearbyDispensaries(lat, lon) {
  if (typeof lat !== 'number' || typeof lon !== 'number' || Number.isNaN(lat) || Number.isNaN(lon)) {
    return { ok: false, reason: 'No location provided.' };
  }

  // Try an ~5mi radius first; widen to ~15mi once if nothing turns up
  // (covers rural areas without making every request slow).
  let outcome = await runQuery(lat, lon, 8000);
  if (!outcome.ok) return outcome;
  let elements = outcome.elements.filter(e => e.tags && e.tags.name);
  if (!elements.length) {
    outcome = await runQuery(lat, lon, 24000);
    if (!outcome.ok) return outcome;
    elements = outcome.elements.filter(e => e.tags && e.tags.name);
  }
  if (!elements.length) {
    return { ok: false, reason: "OpenStreetMap doesn't have any dispensaries listed near that location yet." };
  }

  const results = elements.map(el => {
    const elLat = el.type === 'node' ? el.lat : el.center && el.center.lat;
    const elLon = el.type === 'node' ? el.lon : el.center && el.center.lon;
    const miles = (typeof elLat === 'number' && typeof elLon === 'number') ? distanceMiles(lat, lon, elLat, elLon) : null;
    return {
      id: `osm-${el.type}-${el.id}`,
      name: el.tags.name,
      address: buildAddress(el.tags),
      phone: el.tags.phone || el.tags['contact:phone'] || '',
      website: el.tags.website || el.tags['contact:website'] || '',
      hours: el.tags.opening_hours || '',
      lat: elLat,
      lon: elLon,
      distanceLabel: miles !== null ? `${miles.toFixed(1)} mi` : '',
      distanceMiles: miles,
    };
  }).filter(d => d.lat && d.lon)
    .sort((a, b) => (a.distanceMiles ?? 999) - (b.distanceMiles ?? 999))
    .slice(0, 15);

  if (!results.length) return { ok: false, reason: "OpenStreetMap doesn't have any dispensaries listed near that location yet." };
  return { ok: true, results };
}

module.exports = { findNearbyDispensaries, distanceMiles };
