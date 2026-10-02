// SG Walk Shortcut — in-browser walking router that may cut through buildings (pure, no DOM/network).
// OSM rarely maps paths inside malls or under HDB void decks, so other routers treat those buildings as
// walls. Here, chosen building types get "crossing" edges between the walkable points around their outline.

const WALK_HIGHWAYS = "footway|path|pedestrian|steps|corridor|living_street|residential|service|unclassified|road|track|cycleway|tertiary|tertiary_link|secondary|secondary_link|primary|primary_link";
const EDGE_REACH = 25;        // m: HDB blocks sit back from mapped paths across open ground, so reach that far
const DOOR_SPACING = 10;      // m: keep one way in per this much outline, so long buildings keep every side
const MAX_DOORS = 40;         // per building, keeps crossing edges at most 780 per building
const CROSS_FACTOR = 1.05;    // slight preference for mapped paths when lengths tie
const STEPS_FACTOR = 1.2;
const SNAP_RADIUS = 80;       // m
const MAX_TRIP = 3500;        // m straight-line; beyond this the Overpass download gets too big
// Crossings may not cut across these: you would be wading a canal or jaywalking a main road.
const BARRIER_ROADS = /^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link)$/;

function walkBbox(a, b) {
  const d = haversine(a, b);
  const padM = Math.max(250, d * 0.3);
  const lat0 = (a.lat + b.lat) / 2;
  const dLat = padM / 110540, dLng = padM / (111320 * Math.cos((lat0 * Math.PI) / 180));
  return {
    s: Math.min(a.lat, b.lat) - dLat, n: Math.max(a.lat, b.lat) + dLat,
    w: Math.min(a.lng, b.lng) - dLng, e: Math.max(a.lng, b.lng) + dLng,
  };
}

function bboxContains(outer, inner) {
  return outer && inner.s >= outer.s && inner.n <= outer.n && inner.w >= outer.w && inner.e <= outer.e;
}

function buildWalkQuery({ s, w, n, e }) {
  const b = `(${s.toFixed(5)},${w.toFixed(5)},${n.toFixed(5)},${e.toFixed(5)})`;
  return `[out:json][timeout:25];` +
    `way["highway"~"^(${WALK_HIGHWAYS})$"]["foot"!~"^(no|private)$"]["access"!~"^(private|no)$"]${b}->.w;` +
    `.w out body;node(w.w);out skel qt;` +
    `(way["building"~"^(residential|apartments|commercial|retail|public|train_station)$"]${b};` +
    `way["shop"="mall"]${b};way["building"]["amenity"~"^(marketplace|food_court)$"]${b};);out tags geom;` +
    `way["access"~"^(private|no)$"]["landuse"]${b};out tags geom;` +
    `(way["waterway"~"^(river|canal|stream|drain)$"]${b};way["barrier"~"^(fence|wall|retaining_wall)$"]${b};` +
    `way["highway"~"^(motorway|motorway_link|trunk|trunk_link)$"]${b};);out tags geom;`;
}

// Which crossing class a building belongs to, or null.
function buildingKind(t) {
  if (t.shop === "mall" || t.building === "retail" || t.building === "commercial") return "mall";
  if (t.amenity === "marketplace" || t.amenity === "food_court") return "mall";
  if (t.building === "public" || t.building === "train_station") return "mall";
  if (t.residential === "condominium" || t.residential === "private") return null;
  if (t.building === "residential" || t.building === "apartments") return "hdb";
  return null;
}

// Overpass response -> graph. opts = { hdb: bool, mall: bool }
function buildWalkGraph(raw, opts = { hdb: true, mall: true }) {
  const els = (raw && raw.elements) || [];
  const idx = new Map();
  const lat = [], lng = [];
  for (const el of els) {
    if (el.type === "node" && !idx.has(el.id)) { idx.set(el.id, lat.length); lat.push(el.lat); lng.push(el.lon); }
  }
  const lat0 = lat.length ? lat.reduce((s, v) => s + v, 0) / lat.length : 1.35;
  const proj = makeProj(lat0, lng.length ? lng[0] : 103.8);
  const x = [], y = [];
  for (let i = 0; i < lat.length; i++) { const p = proj(lat[i], lng[i]); x.push(p[0]); y.push(p[1]); }
  const adj = lat.map(() => []);
  const g = { lat, lng, x, y, adj, proj, buildings: [], ways: [] };

  const privateAreas = [];
  const buildings = [];
  const barriers = [];  // [[x, y], [x, y]] segments a crossing may not cut
  for (const el of els) {
    if (el.type !== "way") continue;
    const t = el.tags || {};
    const overUnder = t.bridge === "yes" || t.tunnel === "yes" || t.tunnel === "culvert";
    if (t.highway && el.nodes) {
      const factor = t.highway === "steps" ? STEPS_FACTOR : 1;
      const isBarrier = BARRIER_ROADS.test(t.highway) && !overUnder;
      // Kept for turn-by-turn directions.
      const wIdx = g.ways.push({
        name: t.name || "", highway: t.highway, bridge: t.bridge === "yes", tunnel: t.tunnel || "",
        covered: t.covered === "yes", crossing: t.footway === "crossing" || t.highway === "crossing",
      }) - 1;
      for (let k = 1; k < el.nodes.length; k++) {
        const i = idx.get(el.nodes[k - 1]), j = idx.get(el.nodes[k]);
        if (i === undefined || j === undefined) continue;
        const len = Math.hypot(x[i] - x[j], y[i] - y[j]);
        addEdge(g, i, j, len, len * factor, -1, wIdx);
        if (isBarrier) barriers.push([[x[i], y[i]], [x[j], y[j]]]);
      }
    } else if (el.geometry && (t.waterway || t.barrier || t.highway)) {
      if (overUnder) continue;
      const pts = el.geometry.map((p) => proj(p.lat, p.lon));
      for (let k = 1; k < pts.length; k++) barriers.push([pts[k - 1], pts[k]]);
      if (t.landuse) privateAreas.push(pts);
    } else if (el.geometry && t.landuse && !t.building) {
      privateAreas.push(el.geometry.map((p) => proj(p.lat, p.lon)));
    } else if (el.geometry && el.geometry.length >= 4) {
      const kind = buildingKind(t);
      if (kind && opts[kind]) {
        buildings.push({ kind, name: t.name || "", block: t["addr:housenumber"] || "", ring: el.geometry.map((p) => proj(p.lat, p.lon)) });
      }
    }
  }

  // Gated estates (condos etc.) tagged access=private: their blocks are not walk-through.
  const passable = buildings.filter((bd) => {
    const c = centroid(bd.ring);
    return !privateAreas.some((area) => pointInRing(c, area));
  });

  const grid = makeGrid(x, y, 30);
  const blocked = makeSegmentIndex(barriers, 50);
  for (const bd of passable) {
    // A way in must reach the building without crossing a barrier (e.g. a path on the far bank of a canal).
    const doors = doorsFor(bd.ring, x, y, grid).filter((i) => !blocked.crosses([x[i], y[i]], nearestOnRing([x[i], y[i]], bd.ring)));
    if (doors.length < 2) continue;
    const bIdx = g.buildings.push({ kind: bd.kind, name: bd.name, block: bd.block, ring: bd.ring, doors }) - 1;
    for (let p = 0; p < doors.length; p++) {
      for (let q = p + 1; q < doors.length; q++) {
        const i = doors[p], j = doors[q];
        if (blocked.crosses([x[i], y[i]], [x[j], y[j]])) continue;
        const len = Math.hypot(x[i] - x[j], y[i] - y[j]);
        addEdge(g, i, j, len, len * CROSS_FACTOR, bIdx);
      }
    }
  }
  g.grid = grid;
  return g;
}

function addEdge(g, i, j, len, cost, via, way = -1) {
  if (i === j) return;
  g.adj[i].push({ to: j, len, cost, via, way });
  g.adj[j].push({ to: i, len, cost, via, way });
}

// Path nodes on or near a building outline, thinned to one per DOOR_SPACING around it.
function doorsFor(ring, x, y, grid) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [px, py] of ring) { minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py); }
  const cand = [];
  for (const i of grid.query(minX - EDGE_REACH, minY - EDGE_REACH, maxX + EDGE_REACH, maxY + EDGE_REACH)) {
    const p = [x[i], y[i]];
    if (pointInRing(p, ring) || distToRing(p, ring) <= EDGE_REACH) cand.push(i);
  }
  const [cx, cy] = centroid(ring);
  cand.sort((i, j) => Math.atan2(y[i] - cy, x[i] - cx) - Math.atan2(y[j] - cy, x[j] - cx));
  const kept = [];
  for (const i of cand) {
    if (!kept.some((k) => Math.hypot(x[k] - x[i], y[k] - y[i]) < DOOR_SPACING)) kept.push(i);
  }
  if (kept.length <= MAX_DOORS) return kept;
  const step = kept.length / MAX_DOORS;
  return Array.from({ length: MAX_DOORS }, (_, k) => kept[Math.floor(k * step)]);
}

// Shortest walk from a to b ({lat, lng}). Returns { coords, metres, segments, crossings, legs } or throws.
// legs: one per edge, { from, to, len, place } where place describes what the edge walks along.
function shortestWalk(g, a, b) {
  const n = g.lat.length;
  if (!n) throw new Error("No walkable paths found here");
  const S = n, T = n + 1;
  const extra = { [S]: [], [T]: [] };
  const pa = g.proj(a.lat, a.lng), pb = g.proj(b.lat, b.lng);
  const snap = (p, id) => {
    const near = g.grid.nearest(p[0], p[1], SNAP_RADIUS, g.x, g.y, 4);
    // Starting inside a passable building: you can walk out through any of its ways in.
    for (const bd of g.buildings) if (pointInRing(p, bd.ring)) for (const d of bd.doors) near.push(d);
    for (const i of new Set(near)) {
      const len = Math.hypot(g.x[i] - p[0], g.y[i] - p[1]);
      extra[id].push({ to: i, len, cost: len * 1.2, via: -1 });
    }
  };
  snap(pa, S);
  snap(pb, T);
  if (!extra[S].length || !extra[T].length) throw new Error("Start or end is too far from any mapped path");
  const toT = new Map(extra[T].map((e) => [e.to, e]));

  const dist = new Float64Array(n + 2).fill(Infinity);
  const prev = new Int32Array(n + 2).fill(-1);
  const prevEdge = new Array(n + 2);
  const heap = new MinHeap();
  const h = (i) => (i === T ? 0 : Math.hypot((i === S ? pa[0] : g.x[i]) - pb[0], (i === S ? pa[1] : g.y[i]) - pb[1]));
  dist[S] = 0;
  heap.push(h(S), S);
  while (heap.size) {
    const [f, u] = heap.pop();
    if (u === T) break;
    if (f - h(u) > dist[u] + 1e-9) continue;
    const edges = u === S ? extra[S] : g.adj[u];
    const relax = (e, v) => {
      const nd = dist[u] + e.cost;
      if (nd < dist[v]) { dist[v] = nd; prev[v] = u; prevEdge[v] = e; heap.push(nd + h(v), v); }
    };
    for (const e of edges) relax(e, e.to);
    const end = toT.get(u);
    if (end) relax(end, T);
  }
  if (dist[T] === Infinity) throw new Error("No connected walking route found");

  const nodes = [];
  for (let v = T; v !== -1; v = prev[v]) nodes.push(v);
  nodes.reverse();
  const pt = (i) => (i === S ? [a.lat, a.lng] : i === T ? [b.lat, b.lng] : [g.lat[i], g.lng[i]]);
  const coords = nodes.map(pt);
  let metres = 0;
  const segments = [];   // building crossings: [[lat,lng],[lat,lng]]
  const crossed = new Map();
  const legs = [];
  for (let k = 1; k < nodes.length; k++) {
    const e = prevEdge[nodes[k]];
    metres += e.len;
    const from = pt(nodes[k - 1]), to = pt(nodes[k]);
    let place;
    if (e.via >= 0) {
      segments.push([from, to]);
      crossed.set(e.via, g.buildings[e.via]);
      const bd = g.buildings[e.via];
      place = { type: "building", kind: bd.kind, name: bd.name, block: bd.block, id: e.via };
    } else if (e.way >= 0) {
      place = { type: "way", ...g.ways[e.way] };
    } else {
      place = { type: "open" };   // short hop from the pin to the nearest path
    }
    legs.push({ from, to, len: e.len, place });
  }
  const crossings = [...crossed.values()].map((bd) => ({ kind: bd.kind, name: bd.name, block: bd.block }));
  return { engine: "shortcut", coords, metres: Math.round(metres), segments, crossings, legs };
}

// "via 3 HDB void decks, Toa Payoh Mall"
function describeCrossings(crossings) {
  if (!crossings.length) return "no building shortcut needed";
  const hdb = crossings.filter((c) => c.kind === "hdb").length;
  const malls = crossings.filter((c) => c.kind === "mall");
  const named = [...new Set(malls.map((c) => c.name).filter(Boolean))];
  const parts = [];
  if (hdb) parts.push(`${hdb} HDB void deck${hdb === 1 ? "" : "s"}`);
  if (named.length) parts.push(named.join(", "));
  const unnamed = malls.length - malls.filter((c) => c.name).length;
  if (unnamed) parts.push(`${unnamed} shop/public block${unnamed === 1 ? "" : "s"}`);
  return `via ${parts.join(", ")}`;
}

// ---------- turn-by-turn steps ----------
const MIN_STEP = 15;  // m: shorter plain bits are folded into the step before

// What a leg walks along, in words, e.g. "Yishun Ave 5", "covered linkway", "void deck of Blk 141".
function placeLabel(p) {
  if (p.type === "building") {
    if (p.kind === "hdb") return p.block ? `void deck of Blk ${p.block}` : "HDB void deck";
    if (p.name) return p.name;
    return p.block ? `Blk ${p.block}` : "shop block";
  }
  if (p.type === "open") return "open ground";
  if (p.crossing) return "pedestrian crossing";
  if (p.highway === "steps") return "stairs";
  if (p.tunnel === "building_passage") return p.name || "passage through a building";
  if (p.highway === "corridor") return p.name || "indoor corridor";
  if (p.bridge && /^(footway|path|pedestrian|steps)$/.test(p.highway)) return p.name || "overhead bridge";
  if (p.tunnel === "yes" && /^(footway|path|pedestrian)$/.test(p.highway)) return p.name || "underpass";
  if (p.name) return p.name;
  if (p.covered) return "covered linkway";
  if (p.highway === "cycleway") return "park connector";
  if (p.highway === "pedestrian") return "pedestrian walkway";
  if (p.highway === "service") return "service road";
  if (/^(footway|path|track)$/.test(p.highway)) return "footpath";
  return "road";
}

function bearing([lat1, lng1], [lat2, lng2]) {
  const toR = Math.PI / 180;
  const y = Math.sin((lng2 - lng1) * toR) * Math.cos(lat2 * toR);
  const x = Math.cos(lat1 * toR) * Math.sin(lat2 * toR) - Math.sin(lat1 * toR) * Math.cos(lat2 * toR) * Math.cos((lng2 - lng1) * toR);
  return (Math.atan2(y, x) / toR + 360) % 360;
}

function turnWord(delta) {
  const d = ((delta % 360) + 540) % 360 - 180;  // -180..180, positive = right
  const a = Math.abs(d);
  if (a < 25) return "continue straight";
  const side = d > 0 ? "right" : "left";
  if (a < 60) return `bear ${side}`;
  if (a < 140) return `turn ${side}`;
  return `make a sharp ${side}`;
}

function compass(deg) {
  return ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"][Math.round(deg / 45) % 8];
}

const PLAIN = new Set(["footpath", "road", "service road", "open ground"]);

// Under a roof: through a building (void deck, mall), a covered walkway, an indoor corridor or an underpass.
function isSheltered(p) {
  if (p.type === "building") return true;
  if (p.type !== "way") return false;
  return p.covered || p.highway === "corridor" || p.tunnel === "building_passage" || p.tunnel === "yes";
}

// Route legs -> steps: [{ label, metres, turn, inside, sheltered }]. Consecutive legs along the same thing merge.
function routeSteps(route) {
  const steps = [];
  for (const leg of route.legs || []) {
    if (leg.len < 0.5) continue;
    const label = placeLabel(leg.place);
    const inside = leg.place.type === "building";
    const roof = isSheltered(leg.place) ? leg.len : 0;
    const b = bearing(leg.from, leg.to);
    const last = steps[steps.length - 1];
    if (last && last.label === label && (!inside || last.buildingId === leg.place.id)) {
      last.metres += leg.len;
      last.roof += roof;
      last.endBearing = b;
      continue;
    }
    steps.push({ label, metres: leg.len, roof, startBearing: b, endBearing: b, inside, buildingId: inside ? leg.place.id : undefined });
  }
  // Fold short plain stubs (a 6 m footpath between two roads) into the step before, then re-merge.
  const folded = [];
  for (const s of steps) {
    const prev = folded[folded.length - 1];
    const tiny = s.metres < MIN_STEP && PLAIN.has(s.label);
    if (prev && (tiny || (prev.label === s.label && !s.inside))) {
      prev.metres += s.metres;
      prev.roof += s.roof;
      prev.endBearing = s.endBearing;
      continue;
    }
    folded.push(s);
  }
  return folded.map((s, i) => ({
    label: s.label,
    metres: Math.round(s.metres),
    turn: i === 0 ? `head ${compass(s.startBearing)}` : turnWord(s.startBearing - folded[i - 1].endBearing),
    inside: s.inside,
    sheltered: s.roof >= s.metres / 2,
  }));
}

// How much of the walk is under a roof, and the longest stretches that are not.
function shelterSummary(route, steps) {
  let roof = 0;
  for (const leg of route.legs || []) if (isSheltered(leg.place)) roof += leg.len;
  const total = Math.max(1, route.metres);
  const open = steps.filter((s) => !s.sheltered && s.metres >= 20).sort((x, y) => y.metres - x.metres);
  return {
    pct: Math.min(100, Math.round((roof / total) * 100)),
    openMetres: Math.max(0, Math.round(total - roof)),
    longestOpen: open.slice(0, 2).map((s) => ({ label: s.label, metres: s.metres })),
  };
}

const GENERIC = new Set(["footpath", "road", "service road", "covered linkway", "park connector", "pedestrian walkway",
  "overhead bridge", "underpass", "indoor corridor", "passage through a building", "HDB void deck", "shop block"]);

// "the covered linkway" but "Yishun Avenue 5"; "the void deck of Blk 141" but "Aperia Mall".
function named(label) {
  return GENERIC.has(label) || label.startsWith("void deck") ? `the ${label}` : label;
}

// Steps -> plain sentences: shown as-is without an AI key, and the facts the AI rewrites.
function stepSentences(steps) {
  return steps.map((s) => {
    const turn = s.turn[0].toUpperCase() + s.turn.slice(1);
    if (s.inside) return `${turn} and walk through ${named(s.label)} (${s.metres} m).`;
    if (s.label === "pedestrian crossing") return `${turn} and cross at the pedestrian crossing.`;
    if (s.label === "stairs") return `${turn} and take the stairs (${s.metres} m).`;
    if (s.label === "open ground") return `${turn} across open ground (${s.metres} m).`;
    if (s.label === "overhead bridge" || s.label === "underpass") return `${turn} and take ${named(s.label)} (${s.metres} m).`;
    return `${turn} along ${named(s.label)} for ${s.metres} m.`;
  });
}

// What the AI gets to reword: only the router's own facts, so it has nothing to invent from.
// weather is { rain, forecast, area, period } from forecastFor() in lib.js, or null when unknown.
function directionsFacts(route, steps, fromLabel, toLabel, weather) {
  const pin = (s) => /^Pin -?\d/.test(s || "") ? "map pin" : s || "map pin";
  const facts = {
    from: pin(fromLabel),
    to: pin(toLabel),
    total_metres: route.metres,
    walking_minutes: Math.max(1, Math.round(route.metres / 1.3 / 60)),
    steps: steps.map((s, i) => ({ n: i + 1, turn: s.turn, along: s.label, metres: s.metres, through_building: s.inside, sheltered: s.sheltered })),
  };
  if (weather) {
    const shelter = shelterSummary(route, steps);
    facts.weather = { rain: weather.rain, forecast: weather.forecast, area: weather.area, period: weather.period, sheltered_percent: shelter.pct };
  }
  return facts;
}

// ---------- geometry ----------
function haversine(a, b) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function makeProj(lat0, lng0) {
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180), ky = 110540;
  return (lat, lng) => [(lng - lng0) * kx, (lat - lat0) * ky];
}

function centroid(ring) {
  let sx = 0, sy = 0;
  for (const [px, py] of ring) { sx += px; sy += py; }
  return [sx / ring.length, sy / ring.length];
}

function pointInRing([px, py], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function nearestOnRing([px, py], ring) {
  let best = Infinity, out = ring[0];
  for (let i = 1; i < ring.length; i++) {
    const [ax, ay] = ring[i - 1], [bx, by] = ring[i];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
    const q = [ax + t * dx, ay + t * dy], d = Math.hypot(px - q[0], py - q[1]);
    if (d < best) { best = d; out = q; }
  }
  return out;
}

// Strict crossing only: segments that merely touch (a door node on the road itself) don't count.
function segmentsCross(p1, p2, p3, p4) {
  const o = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const eps = 1e-6;
  const d1 = o(p3, p4, p1), d2 = o(p3, p4, p2), d3 = o(p1, p2, p3), d4 = o(p1, p2, p4);
  return ((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) && ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps));
}

function makeSegmentIndex(segs, cell) {
  const cells = new Map();
  const key = (cx, cy) => `${cx},${cy}`;
  const span = (a, b) => [
    Math.floor(Math.min(a[0], b[0]) / cell), Math.floor(Math.min(a[1], b[1]) / cell),
    Math.floor(Math.max(a[0], b[0]) / cell), Math.floor(Math.max(a[1], b[1]) / cell),
  ];
  segs.forEach((sg, n) => {
    const [x0, y0, x1, y1] = span(sg[0], sg[1]);
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
      const k = key(cx, cy);
      if (!cells.has(k)) cells.set(k, []);
      cells.get(k).push(n);
    }
  });
  return {
    crosses(a, b) {
      const [x0, y0, x1, y1] = span(a, b);
      const seen = new Set();
      for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
        for (const n of cells.get(key(cx, cy)) || []) {
          if (seen.has(n)) continue;
          seen.add(n);
          if (segmentsCross(a, b, segs[n][0], segs[n][1])) return true;
        }
      }
      return false;
    },
  };
}

function distToRing(p, ring) {
  let best = Infinity;
  for (let i = 1; i < ring.length; i++) best = Math.min(best, distToSeg(p, ring[i - 1], ring[i]));
  return best;
}

function distToSeg([px, py], [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function makeGrid(x, y, cell) {
  const cells = new Map();
  const key = (cx, cy) => `${cx},${cy}`;
  for (let i = 0; i < x.length; i++) {
    const k = key(Math.floor(x[i] / cell), Math.floor(y[i] / cell));
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(i);
  }
  return {
    query(x0, y0, x1, y1) {
      const out = [];
      for (let cx = Math.floor(x0 / cell); cx <= Math.floor(x1 / cell); cx++)
        for (let cy = Math.floor(y0 / cell); cy <= Math.floor(y1 / cell); cy++) {
          const c = cells.get(key(cx, cy));
          if (c) out.push(...c);
        }
      return out;
    },
    // Up to k nearest within r; if none, the single nearest overall.
    nearest(px, py, r, xs, ys, k) {
      const d = (i) => Math.hypot(xs[i] - px, ys[i] - py);
      const within = this.query(px - r, py - r, px + r, py + r).filter((i) => d(i) <= r).sort((i, j) => d(i) - d(j));
      if (within.length) return within.slice(0, k);
      let best = -1, bd = Infinity;
      for (let i = 0; i < xs.length; i++) if (d(i) < bd) { bd = d(i); best = i; }
      return best < 0 ? [] : [best];
    },
  };
}

class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(k, v) {
    const a = this.a;
    a.push([k, v]);
    for (let i = a.length - 1; i > 0;) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

if (typeof module !== "undefined") {
  module.exports = { walkBbox, bboxContains, buildWalkQuery, buildWalkGraph, shortestWalk, describeCrossings, routeSteps, stepSentences, shelterSummary, directionsFacts, haversine, MAX_TRIP };
}
