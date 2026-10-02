// SG Walk Shortcut — pure helpers (no DOM, no network). Loaded by index.html and by node for checks.

const WALK_SPEED = 1.3; // m/s, same for every engine so times are comparable

// Google/Valhalla encoded polyline -> [[lat, lng], ...]. precision 6 for Valhalla, 5 for OneMap.
function decodePolyline(str, precision = 6) {
  const factor = Math.pow(10, precision);
  const out = [];
  let i = 0, lat = 0, lng = 0;
  while (i < str.length) {
    for (const axis of [0, 1]) {
      let shift = 0, result = 0, b;
      do {
        b = str.charCodeAt(i++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta; else lng += delta;
    }
    out.push([lat / factor, lng / factor]);
  }
  return out;
}

// Raw engine response -> { engine, coords: [[lat, lng]], metres }
function normaliseRoute(engine, raw) {
  if (engine === "valhalla") {
    const trip = raw && raw.trip;
    if (!trip) throw new Error((raw && raw.error) || "No route");
    const coords = trip.legs.flatMap((leg) => decodePolyline(leg.shape, 6));
    return { engine, coords, metres: Math.round(trip.summary.length * 1000) };
  }
  if (engine === "osrm") {
    const r = raw && raw.routes && raw.routes[0];
    if (!r) throw new Error((raw && raw.message) || "No route");
    return { engine, coords: r.geometry.coordinates.map(([lng, lat]) => [lat, lng]), metres: Math.round(r.distance) };
  }
  if (engine === "onemap") {
    if (!raw || !raw.route_geometry) throw new Error((raw && (raw.error || raw.message)) || "No route");
    return { engine, coords: decodePolyline(raw.route_geometry, 5), metres: Math.round(raw.route_summary.total_distance) };
  }
  throw new Error(`Unknown engine ${engine}`);
}

function walkMinutes(metres) {
  return Math.max(1, Math.round(metres / WALK_SPEED / 60));
}

function formatDistance(metres) {
  return metres < 1000 ? `${metres} m` : `${(metres / 1000).toFixed(2)} km`;
}

// Adds savedMetres (vs the longest route) and shortest flag to each route.
function compareRoutes(routes) {
  if (!routes.length) return [];
  const longest = Math.max(...routes.map((r) => r.metres));
  const shortest = Math.min(...routes.map((r) => r.metres));
  return routes.map((r) => ({ ...r, savedMetres: longest - r.metres, shortest: routes.length > 1 && r.metres === shortest }));
}

// Walkable ways that cut through or under buildings. bbox = {s, w, n, e}.
function buildOverpassQuery({ s, w, n, e }) {
  const b = `(${s.toFixed(5)},${w.toFixed(5)},${n.toFixed(5)},${e.toFixed(5)})`;
  return `[out:json][timeout:25];(` +
    `way["tunnel"="building_passage"]${b};` +
    `way["highway"="corridor"]${b};` +
    `way["highway"~"^(footway|path|pedestrian|steps)$"]["covered"="yes"]${b};` +
    `);out geom;`;
}

// Overpass elements -> [{ id, kind, coords }]
function parsePassages(raw) {
  return ((raw && raw.elements) || [])
    .filter((el) => el.type === "way" && el.geometry)
    .map((el) => {
      const t = el.tags || {};
      const kind = t.tunnel === "building_passage" ? "Building passage" : t.highway === "corridor" ? "Indoor corridor" : "Covered walkway";
      return { id: el.id, kind, name: t.name || "", coords: el.geometry.map((p) => [p.lat, p.lon]) };
    });
}

// Offline tile (tools/build_tiles.py) -> Overpass-style elements, the shape buildWalkGraph reads.
function decodeTile(doc) {
  const els = [];
  const ids = [];
  let id = 0, la = 0, lo = 0;
  for (let i = 0; i < doc.ni.length; i++) {
    id += doc.ni[i]; la += doc.na[i]; lo += doc.no[i];
    ids.push(id);
    els.push({ type: "node", id, lat: la / 1e6, lon: lo / 1e6 });
  }
  for (const [wid, ti, refs] of doc.w) {
    els.push({ type: "way", id: wid, tags: doc.t[ti], nodes: refs.map((r) => ids[r]) });
  }
  for (const [gid, ti, flat] of doc.g) {
    const geometry = [];
    let a = 0, b = 0;
    for (let k = 0; k < flat.length; k += 2) {
      a += flat[k]; b += flat[k + 1];
      geometry.push({ lat: a / 1e6, lon: b / 1e6 });
    }
    // "g" ids are area or barrier ids, a separate namespace from walkable way ids.
    els.push({ type: "way", id: `g${gid}`, tags: doc.t[ti], geometry });
  }
  return els;
}

// Several tiles' elements -> one Overpass-style response; features on tile edges appear once.
function mergeTiles(tileElements) {
  const seen = new Set();
  const elements = [];
  for (const els of tileElements) {
    for (const el of els) {
      const key = `${el.type}:${el.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      elements.push(el);
    }
  }
  return { elements };
}

// Tile names ("<floor(lat/size)>_<floor(lon/size)>") that cover a bbox.
function tilesFor({ s, w, n, e }, size) {
  const out = [];
  const f = (v) => Math.floor(v / size + 1e-9);
  for (let y = f(s); y <= f(n); y++) for (let x = f(w); x <= f(e); x++) out.push(`${y}_${x}`);
  return out;
}

// The Shortcut router's Overpass download (ways with node ids + bare nodes) -> passage ways with
// geometry, in the shape parsePassages expects.
function walkPassageElements(raw) {
  const els = (raw && raw.elements) || [];
  const nodes = new Map();
  for (const el of els) if (el.type === "node") nodes.set(el.id, el);
  const isPassage = (t) => t.tunnel === "building_passage" || t.highway === "corridor" ||
    (t.covered === "yes" && /^(footway|path|pedestrian|steps)$/.test(t.highway));
  const out = [];
  for (const el of els) {
    if (el.type !== "way" || !el.nodes || !el.tags || !el.tags.highway || !isPassage(el.tags)) continue;
    const geometry = el.nodes.map((id) => nodes.get(id)).filter(Boolean).map((n) => ({ lat: n.lat, lon: n.lon }));
    if (geometry.length > 1) out.push({ type: "way", id: el.id, tags: el.tags, geometry });
  }
  return { elements: out };
}

// "1. Walk ...\n2) Turn ...\nTotal: ..." -> ["Walk ...", "Turn ...", "Total: ..."]. Falls back to non-empty lines.
function parseNumberedList(text) {
  const lines = String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const numbered = lines.map((l) => l.match(/^(?:\d+[.)]|[-*•])\s+(.*)$/)).filter(Boolean).map((m) => m[1]);
  const total = lines.find((l) => /^\**total\**:/i.test(l));
  const rain = lines.find((l) => /^\**rain\**:/i.test(l));
  const out = numbered.length ? numbered : lines;
  if (numbered.length && rain) out.unshift(rain.replace(/\*\*/g, ""));
  if (numbered.length && total) out.push(total.replace(/\*\*/g, ""));
  return out.map((l) => l.replace(/\*\*(.+?)\*\*/g, "$1"));
}

// NEA's 2-hour forecast wording that means getting wet: "Showers", "Light Rain", "Thundery Showers"...
const RAIN_WORDS = /rain|shower|thunder|drizzle/i;
function rainRank(forecast) {
  if (!RAIN_WORDS.test(forecast)) return 0;
  return /thunder/i.test(forecast) ? 3 : /heavy/i.test(forecast) ? 2 : 1;
}

// data.gov.sg two-hr-forecast payload + route points [{lat, lng}] -> the worst forecast among the areas
// nearest those points: { rain, forecast, area, period }, or null when the payload has no forecast.
function forecastFor(payload, points) {
  const data = payload && payload.data;
  const item = data && data.items && data.items[0];
  if (!item || !data.area_metadata || !item.forecasts) return null;
  const byArea = new Map(item.forecasts.map((f) => [f.area, f.forecast]));
  const nearest = (p) => {
    let best = null, bd = Infinity;
    for (const a of data.area_metadata) {
      const d = (a.label_location.latitude - p.lat) ** 2 + ((a.label_location.longitude - p.lng) * Math.cos((p.lat * Math.PI) / 180)) ** 2;
      if (d < bd) { bd = d; best = a.name; }
    }
    return best;
  };
  const areas = [...new Set(points.map(nearest).filter(Boolean))];
  if (!areas.length) return null;
  const worst = areas.reduce((w, a) => (rainRank(byArea.get(a) || "") > rainRank(byArea.get(w) || "") ? a : w), areas[0]);
  const forecast = byArea.get(worst) || "Unknown";
  return {
    rain: rainRank(forecast) > 0,
    forecast: forecast.replace(/\s*\((Day|Night)\)$/, ""),
    area: worst,
    period: (item.valid_period && item.valid_period.text) || "",
  };
}

function googleMapsUrl(a, b) {
  return `https://www.google.com/maps/dir/?api=1&origin=${a.lat},${a.lng}&destination=${b.lat},${b.lng}&travelmode=walking`;
}

function osmEditUrl(lat, lng) {
  return `https://www.openstreetmap.org/edit#map=19/${lat.toFixed(6)}/${lng.toFixed(6)}`;
}

// "#a=1.33,103.84&b=1.34,103.85" <-> { a, b }
function parseHash(hash) {
  const out = {};
  for (const part of hash.replace(/^#/, "").split("&")) {
    const [k, v] = part.split("=");
    if ((k === "a" || k === "b") && v) {
      const [lat, lng] = v.split(",").map(Number);
      if (Number.isFinite(lat) && Number.isFinite(lng)) out[k] = { lat, lng };
    }
  }
  return out;
}

function buildHash(a, b) {
  const f = (p) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
  return [a && `a=${f(a)}`, b && `b=${f(b)}`].filter(Boolean).join("&");
}

if (typeof module !== "undefined") {
  module.exports = { decodePolyline, normaliseRoute, walkMinutes, formatDistance, compareRoutes, buildOverpassQuery, parsePassages, walkPassageElements, decodeTile, mergeTiles, tilesFor, parseNumberedList, forecastFor, googleMapsUrl, osmEditUrl, parseHash, buildHash };
}
