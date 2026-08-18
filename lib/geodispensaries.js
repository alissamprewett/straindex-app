// geodispensaries.js — real, live dispensary lookup by GPS coordinates.
//
// Two backends, chosen automatically:
//   1. Google Places API (New) — used whenever GOOGLE_PLACES_API_KEY is set.
//      Paid (per Google's pricing), but reliable — no shared free-tier
//      infrastructure to go down. Uses Text Search (New) rather than a
//      strict place-type filter, since Google's place-type list doesn't
//      have a clearly documented, guaranteed "cannabis dispensary" type —
//      a free-text query is the documented, robust way to search a
//      category like this.
//   2. OpenStreetMap's free Overpass API — used automatically when no
//      Google key is configured (e.g. local development). No signup, no
//      cost, but crowdsourced coverage and occasional mirror downtime are
//      the tradeoff — see the comments below on OVERPASS_ENDPOINTS.
//
// Both backends return the same shape — { ok, results, reason } — so
// nothing else in the app needs to know or care which one actually ran.

const TIMEOUT_MS = 10000;

function toRad(deg) { return (deg * Math.PI) / 180; }

// Haversine distance in miles between two lat/lon points.
function distanceMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8; // Earth radius in miles
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---------------------------------------------------------------- Google Places (New)
const GOOGLE_FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.nationalPhoneNumber',
  'places.websiteUri',
  'places.regularOpeningHours',
  'places.rating',
].join(',');

async function findNearbyDispensariesGoogle(lat, lon) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': GOOGLE_FIELD_MASK,
      },
      body: JSON.stringify({
        textQuery: 'cannabis dispensary',
        maxResultCount: 15,
        locationBias: {
          circle: { center: { latitude: lat, longitude: lon }, radius: 24000 },
        },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      console.error(`[geodispensaries] Google Places returned ${res.status}: ${bodyText.slice(0, 300)}`);
      return { ok: false, reason: `Dispensary lookup returned an error (status ${res.status}).` };
    }
    const data = await res.json();
    const places = data.places || [];
    if (!places.length) {
      return { ok: false, reason: "No dispensaries found near that location." };
    }
    const results = places.map(p => ({
      id: `gp-${p.id}`,
      name: p.displayName && p.displayName.text || 'Unnamed dispensary',
      address: p.formattedAddress || '',
      phone: p.nationalPhoneNumber || '',
      website: p.websiteUri || '',
      hours: p.regularOpeningHours
        ? (p.regularOpeningHours.openNow ? 'Open now' : 'Closed now')
        : '',
      rating: typeof p.rating === 'number' ? p.rating : null,
      lat: p.location ? p.location.latitude : null,
      lon: p.location ? p.location.longitude : null,
      distanceLabel: p.location ? `${distanceMiles(lat, lon, p.location.latitude, p.location.longitude).toFixed(1)} mi` : '',
      distanceMiles: p.location ? distanceMiles(lat, lon, p.location.latitude, p.location.longitude) : null,
    })).sort((a, b) => (a.distanceMiles ?? 999) - (b.distanceMiles ?? 999));
    return { ok: true, results };
  } catch (err) {
    console.error('[geodispensaries] Google Places fetch failed:', err.message || err);
    if (err.name === 'AbortError') return { ok: false, reason: 'The dispensary lookup timed out.' };
    return { ok: false, reason: 'Could not reach the dispensary lookup service.' };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- OpenStreetMap Overpass (free fallback)
// Race a few independent public Overpass instances at once — these free,
// community-run servers get overloaded and 504/time out fairly often
// (observed directly while building this), so querying several in parallel
// and taking whichever answers first is much more reliable than trying one
// at a time. Still, being free community infrastructure, all of them can be
// down at once — that's the tradeoff of not paying for Google Places.
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

class OverpassError extends Error {}

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

async function findNearbyDispensariesOverpass(lat, lon) {
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
      rating: null,
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

// Returns { ok: true, results: [...] } or { ok: false, reason: string }
async function findNearbyDispensaries(lat, lon) {
  if (typeof lat !== 'number' || typeof lon !== 'number' || Number.isNaN(lat) || Number.isNaN(lon)) {
    return { ok: false, reason: 'No location provided.' };
  }
  if (process.env.GOOGLE_PLACES_API_KEY) {
    return findNearbyDispensariesGoogle(lat, lon);
  }
  return findNearbyDispensariesOverpass(lat, lon);
}

// Geocodes a 5-digit US ZIP code to lat/lon using Zippopotam.us — a free,
// no-signup, no-API-key lookup, and deliberately a *different* free service
// than Overpass (separate infrastructure/operator), so a ZIP search doesn't
// share a single point of failure with the dispensary lookup itself.
// Returns { ok: true, lat, lon, label } or { ok: false, reason }.
async function geocodeZip(zip) {
  const cleaned = String(zip || '').trim();
  if (!/^\d{5}$/.test(cleaned)) {
    return { ok: false, reason: 'Enter a 5-digit US ZIP code.' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.zippopotam.us/us/${cleaned}`, {
      headers: { 'User-Agent': 'StrainDexApp/1.0 (contact: alissa.m.prewett@gmail.com)' },
      signal: controller.signal,
    });
    if (res.status === 404) return { ok: false, reason: `ZIP code ${cleaned} wasn't found.` };
    if (!res.ok) return { ok: false, reason: `ZIP code lookup returned an error (status ${res.status}).` };
    const data = await res.json();
    const place = data.places && data.places[0];
    if (!place || !place.latitude || !place.longitude) return { ok: false, reason: `ZIP code ${cleaned} wasn't found.` };
    return {
      ok: true,
      lat: Number(place.latitude),
      lon: Number(place.longitude),
      label: `${place['place name']}, ${place['state abbreviation']} ${cleaned}`,
    };
  } catch (err) {
    console.error('[geodispensaries] zip geocode failed:', err.message || err);
    if (err.name === 'AbortError') return { ok: false, reason: 'The ZIP code lookup timed out.' };
    return { ok: false, reason: 'Could not reach the ZIP code lookup service.' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { findNearbyDispensaries, distanceMiles, geocodeZip };
