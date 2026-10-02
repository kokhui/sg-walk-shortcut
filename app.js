// SG Walk Shortcut — frontend. Pure helpers live in lib.js.
const $ = (s, root = document) => root.querySelector(s);

const ENGINES = {
  shortcut: { label: "Shortcut", note: "cuts through buildings", color: "--shortcut" },
  valhalla: { label: "Valhalla", note: "OSM, prefers footways", color: "--valhalla" },
  osrm: { label: "OSRM foot", note: "OSM, shortest walk", color: "--osrm" },
  onemap: { label: "OneMap", note: "SLA, road-based baseline", color: "--onemap" },
};
const PASSAGE_MIN_ZOOM = 16;
// Public Overpass servers, tried in order when one is rate-limiting (429) or overloaded (504).
const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

const state = {
  a: null,          // {lat, lng, label}
  b: null,
  routes: [],       // compared routes
  selected: null,   // engine key
  routeRun: 0,      // ignore stale responses
  passageKey: "",
  walkData: null,   // { bbox, raw } last Overpass download for the Shortcut router
  walkFetch: null,  // { bbox, promise, ctrl } the one walk-data download under way
  passageCtrl: null,
  picked: false,    // user tapped a route this run, so stop auto-selecting the shortest
};

const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

// ---------- map ----------
const map = L.map("map", { zoomControl: false }).setView([1.3521, 103.8198], 12);
L.control.zoom({ position: "bottomleft" }).addTo(map);
const dark = matchMedia("(prefers-color-scheme: dark)").matches;
// OneMap (SLA) tiles: Singapore's official basemap, and it works from file:// (no Referer needed).
L.tileLayer(`https://www.onemap.gov.sg/maps/tiles/${dark ? "Night" : "Default"}/{z}/{x}/{y}.png`, {
  minZoom: 11,
  maxZoom: 19,
  bounds: [[1.144, 103.535], [1.494, 104.1]],
  attribution: '<a href="https://www.onemap.gov.sg/" target="_blank" rel="noopener">OneMap</a> &copy; contributors | <a href="https://www.sla.gov.sg/" target="_blank" rel="noopener">Singapore Land Authority</a> | Routes &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
}).addTo(map);

const layers = {
  passages: L.layerGroup().addTo(map),
  routes: L.layerGroup().addTo(map),
  pins: L.layerGroup().addTo(map),
};
const markers = {};

function pinIcon(key) {
  return L.divIcon({
    className: "",
    html: `<span class="pin pin-${key} marker-pin">${key.toUpperCase()}</span>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });
}

// ---------- storage (may be unavailable) ----------
function loadToken() {
  try { return localStorage.getItem("onemapToken") || ""; } catch { return ""; }
}
function saveToken(t) {
  try { t ? localStorage.setItem("onemapToken", t) : localStorage.removeItem("onemapToken"); } catch {}
}

// ---------- fetch (IO only) ----------
async function getJson(url, opts) {
  const res = await fetch(url, opts);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body && (body.error || body.message)) || `HTTP ${res.status}`);
  return body;
}

async function searchPlace(q) {
  const url = `https://www.onemap.gov.sg/api/common/elastic/search?searchVal=${encodeURIComponent(q)}&returnGeom=Y&getAddrDetails=Y&pageNum=1`;
  const data = await getJson(url);
  return (data.results || []).slice(0, 8).map((r) => ({
    lat: Number(r.LATITUDE),
    lng: Number(r.LONGITUDE),
    label: titleCase(r.SEARCHVAL),
    sub: r.ADDRESS && r.ADDRESS !== "NIL" ? titleCase(r.ADDRESS) : "",
  }));
}

function routeValhalla(a, b) {
  const req = {
    locations: [{ lat: a.lat, lon: a.lng }, { lat: b.lat, lon: b.lng }],
    costing: "pedestrian",
    // <1 makes sidewalks/footways (incl. void-deck passages) cheaper than walking along roads.
    costing_options: { pedestrian: { walkway_factor: 0.8, sidewalk_factor: 0.9 } },
    units: "kilometers",
  };
  return getJson(`https://valhalla1.openstreetmap.de/route?json=${encodeURIComponent(JSON.stringify(req))}`);
}

function routeOsrm(a, b) {
  return getJson(`https://routing.openstreetmap.de/routed-foot/route/v1/foot/${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson`);
}

function routeOneMap(a, b, token) {
  const url = `https://www.onemap.gov.sg/api/public/routingsvc/route?start=${a.lat},${a.lng}&end=${b.lat},${b.lng}&routeType=walk`;
  return getJson(url, { headers: { Authorization: token } });
}

// GET, not POST: the Overpass servers reject some POST clients with 406. A 429 arrives without CORS
// headers, so the browser reports it as "Failed to fetch". Servers are raced: if one fails, or has not
// answered within OVERPASS_HEDGE_MS, the next one starts too, and the first good answer wins.
const OVERPASS_HEDGE_MS = 3000;
const OVERPASS_TIMEOUT_MS = 45000;
function overpass(query, signal) {
  return new Promise((resolve, reject) => {
    const ctrls = [];
    let next = 0, pending = 0, done = false, lastErr;
    const finish = (fn, v) => { done = true; ctrls.forEach((c) => c.abort()); fn(v); };
    if (signal) signal.addEventListener("abort", () => { if (!done) finish(reject, new Error("cancelled")); }, { once: true });
    const start = () => {
      if (done || next >= OVERPASS.length) return;
      const ctrl = new AbortController();
      ctrls.push(ctrl);
      const timer = setTimeout(() => ctrl.abort(new Error("timed out")), OVERPASS_TIMEOUT_MS);
      pending++;
      getJson(`${OVERPASS[next++]}?data=${encodeURIComponent(query)}`, { signal: ctrl.signal })
        .then((v) => { if (!done) finish(resolve, v); }, (err) => {
          lastErr = err;
          pending--;
          if (done) return;
          start();
          if (!pending) finish(reject, lastErr);
        })
        .finally(() => clearTimeout(timer));
    };
    start();
    setTimeout(start, OVERPASS_HEDGE_MS);
  });
}

function fetchWalkData(bbox, signal) {
  return overpass(buildWalkQuery(bbox), signal);
}

// Downloaded areas kept in IndexedDB, so a repeat or nearby route skips the slow Overpass call.
// Bump CACHE_VERSION whenever buildWalkQuery changes what it asks for.
const walkCache = (() => {
  const CACHE_VERSION = 2, MAX_AGE = 7 * 24 * 3600e3, MAX_ENTRIES = 20;
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open("sg-walk-shortcut", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("walk", { keyPath: "key" });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const all = async () => {
    const db = await open();
    return new Promise((res, rej) => {
      const r = db.transaction("walk").objectStore("walk").getAll();
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  };
  return {
    async find(need) {
      try {
        const now = Date.now();
        return (await all()).find((e) => e.v === CACHE_VERSION && now - e.at < MAX_AGE && bboxContains(e.bbox, need)) || null;
      } catch { return null; }
    },
    async put(bbox, raw) {
      try {
        const db = await open();
        const old = (await all()).sort((x, y) => y.at - x.at).slice(MAX_ENTRIES - 1);
        const store = db.transaction("walk", "readwrite").objectStore("walk");
        for (const e of old) store.delete(e.key);
        store.put({ key: JSON.stringify(bbox), v: CACHE_VERSION, at: Date.now(), bbox, raw });
      } catch {}
    },
  };
})();

// Download a little more than needed, so dragging a pin or a nearby walk is served from cache.
function downloadBbox(need) {
  const padLat = 0.002, padLng = 0.002, snap = (v, f) => f(v / 0.002) * 0.002;
  return {
    s: snap(need.s - padLat, Math.floor), w: snap(need.w - padLng, Math.floor),
    n: snap(need.n + padLat, Math.ceil), e: snap(need.e + padLng, Math.ceil),
  };
}

// Offline tiles built by tools/build_tiles.py. When they cover a walk, no Overpass call is needed.
const tiles = {
  index: null,           // promise of tiles/index.json, or of null when there are no tiles
  loaded: new Map(),     // name -> promise of decoded elements
  MAX_LOADED: 80,
};
function tileIndex() {
  if (!tiles.index) {
    tiles.index = getJson("tiles/index.json").then((idx) => {
      idx.have = new Set(idx.tiles);
      const el = document.getElementById("data-date");
      if (el) el.textContent = ` Offline map data built ${idx.built}.`;
      return idx;
    }).catch(() => null);
  }
  return tiles.index;
}
function loadTile(name) {
  if (!tiles.loaded.has(name)) {
    if (tiles.loaded.size >= tiles.MAX_LOADED) tiles.loaded.delete(tiles.loaded.keys().next().value);
    const p = getJson(`tiles/${name}.json`).then(decodeTile);
    p.catch(() => tiles.loaded.delete(name));
    tiles.loaded.set(name, p);
  }
  return tiles.loaded.get(name);
}
async function loadLocalWalkData(need) {
  const idx = await tileIndex();
  if (!idx) return null;
  const [s, w, n, e] = idx.bbox;
  if (!bboxContains({ s, w, n, e }, need)) return null;
  const size = idx.tile;
  // Tiles missing from the index inside the covered box are empty (sea), not missing.
  const els = await Promise.all(tilesFor(need, size).filter((t) => idx.have.has(t)).map(loadTile));
  const bbox = {
    s: Math.floor(need.s / size) * size, w: Math.floor(need.w / size) * size,
    n: Math.ceil(need.n / size) * size, e: Math.ceil(need.e / size) * size,
  };
  return { bbox, raw: mergeTiles(els) };
}

async function loadWalkData(need, onStatus) {
  if (bboxContains(state.walkData && state.walkData.bbox, need)) return state.walkData;
  const found = (await loadLocalWalkData(need).catch(() => null)) || (await walkCache.find(need));
  if (found) {
    state.walkData = { bbox: found.bbox, raw: found.raw };
    state.passageBounds = null;
    updatePassages();
    return state.walkData;
  }
  onStatus("Downloading map data for this area… (can take 20 s)");
  // One big download at a time: busy servers refuse parallel ones. Join a download already under way
  // if it covers this walk, otherwise cancel it (its route is stale) and the overlay's request too.
  const inFlight = state.walkFetch;
  if (inFlight && bboxContains(inFlight.bbox, need)) return inFlight.promise;
  if (inFlight) inFlight.ctrl.abort();
  if (state.passageCtrl) state.passageCtrl.abort();
  const bbox = downloadBbox(need);
  const ctrl = new AbortController();
  const job = {
    bbox,
    ctrl,
    promise: fetchWalkData(bbox, ctrl.signal).then((raw) => {
      walkCache.put(bbox, raw);
      state.walkData = { bbox, raw };
      return state.walkData;
    }).finally(() => {
      if (state.walkFetch !== job) return;
      state.walkFetch = null;
      state.passageBounds = null;
      updatePassages();
    }),
  };
  state.walkFetch = job;
  return job.promise;
}

async function routeShortcut(a, b, onStatus) {
  if (haversine(a, b) > MAX_TRIP) throw new Error(`Works for walks up to ${MAX_TRIP / 1000} km apart`);
  const data = await loadWalkData(walkBbox(a, b), onStatus);
  const graph = buildWalkGraph(data.raw, { hdb: $("#cut-hdb").checked, mall: $("#cut-mall").checked });
  return shortestWalk(graph, a, b);
}

async function fetchPassages(bbox, signal) {
  const local = await loadLocalWalkData(bbox).catch(() => null);
  if (local) return walkPassageElements(local.raw);
  return overpass(buildOverpassQuery(bbox), signal);
}

// ---------- routing ----------
async function updateRoutes() {
  syncHash();
  renderPins();
  const { a, b } = state;
  $("#gmaps").hidden = !(a && b);
  if (!(a && b)) {
    layers.routes.clearLayers();
    $("#routes").hidden = true;
    $("#directions").hidden = true;
    $("#weather").hidden = true;
    $("#empty").hidden = false;
    return;
  }
  $("#gmaps").href = googleMapsUrl(a, b);
  $("#empty").hidden = true;
  $("#routes").hidden = false;

  const run = ++state.routeRun;
  state.picked = false;
  const token = loadToken();
  const jobs = {
    shortcut: () => routeShortcut(a, b, (msg) => { if (run === state.routeRun) { results.shortcut = { engine: "shortcut", loading: msg }; render(); } }),
    valhalla: () => routeValhalla(a, b).then((raw) => normaliseRoute("valhalla", raw)),
    osrm: () => routeOsrm(a, b).then((raw) => normaliseRoute("osrm", raw)),
    onemap: token ? () => routeOneMap(a, b, token).then((raw) => normaliseRoute("onemap", raw)) : null,
  };
  // Each card fills in as its engine answers, rather than waiting for the slowest one.
  const results = {};
  for (const k of Object.keys(ENGINES)) {
    results[k] = jobs[k] ? { engine: k, loading: "Finding route…" } : { engine: k, error: "Add a OneMap token below to compare" };
  }
  const render = () => {
    const all = Object.values(results);
    state.routes = compareRoutes(all.filter((r) => r.coords)).sort((x, y) => x.metres - y.metres);
    // Follow the shortest route until the user taps one.
    if (!state.picked || !state.routes.some((r) => r.engine === state.selected)) {
      state.selected = state.routes[0] ? state.routes[0].engine : null;
    }
    renderCards([...state.routes, ...all.filter((r) => r.loading), ...all.filter((r) => r.error)]);
    drawRoutes();
    renderDirections();
    renderWeather();
  };
  render();

  for (const k of Object.keys(jobs).filter((k) => jobs[k])) {
    jobs[k]().then(
      (route) => { results[k] = route; },
      (err) => { results[k] = { engine: k, error: errorText(k, err) }; },
    ).then(() => {
      if (run !== state.routeRun) return;
      render();
      if (results[k].coords) fitIfHidden(results[k].coords);
    });
  }
}

// Zoom out to a route only if part of it is off screen, so late answers don't make the map jump.
function fitIfHidden(coords) {
  const bounds = L.latLngBounds(coords);
  if (map.getBounds().contains(bounds) && map.getZoom() >= 14) return;
  const all = L.latLngBounds(state.routes.flatMap((r) => r.coords));
  map.fitBounds(all, { paddingTopLeft: [40, 40], paddingBottomRight: paddingForPanel() });
}

function drawRoutes() {
  layers.routes.clearLayers();
  // Unselected first so the selected route draws on top.
  const ordered = [...state.routes].sort((x, y) => (x.engine === state.selected) - (y.engine === state.selected));
  for (const r of ordered) {
    const sel = r.engine === state.selected;
    L.polyline(r.coords, {
      color: css(ENGINES[r.engine].color),
      weight: sel ? 7 : 4,
      opacity: sel ? 0.95 : 0.55,
      lineCap: "round",
      lineJoin: "round",
    })
      .on("click", () => selectRoute(r.engine))
      .bindTooltip(`${ENGINES[r.engine].label}: ${formatDistance(r.metres)}`, { sticky: true })
      .addTo(layers.routes);
    // Parts of the Shortcut route that go through a building.
    if (sel && r.segments) {
      for (const seg of r.segments) {
        L.polyline(seg, { color: "#fff", weight: 3, dashArray: "3 7", opacity: 0.95, interactive: false }).addTo(layers.routes);
      }
    }
  }
}

function selectRoute(engine) {
  if (!state.routes.some((r) => r.engine === engine)) return;
  state.picked = true;
  state.selected = engine;
  drawRoutes();
  document.querySelectorAll(".card").forEach((c) => c.classList.toggle("selected", c.dataset.engine === engine));
}

function renderCards(items) {
  const box = $("#cards");
  box.replaceChildren(...items.map((it) => {
    const e = ENGINES[it.engine];
    const el = document.createElement("button");
    el.type = "button";
    el.className = "card";
    el.dataset.engine = it.engine;
    el.style.setProperty("--c", `var(${e.color})`);
    if (it.loading || it.error) {
      el.classList.add(it.loading ? "loading" : "error");
      el.disabled = true;
      el.innerHTML = `<div><div class="name"></div><div class="meta"></div></div>`;
      $(".name", el).textContent = e.label;
      $(".meta", el).textContent = it.loading || it.error;
      return el;
    }
    el.classList.toggle("selected", it.engine === state.selected);
    el.innerHTML = `
      <div>
        <div class="name"></div>
        <div class="meta"></div>
      </div>
      <div class="time">${walkMinutes(it.metres)} min<small>${formatDistance(it.metres)}</small></div>`;
    $(".name", el).textContent = e.label;
    if (it.shortest) $(".name", el).insertAdjacentHTML("beforeend", `<span class="badge">Shortest</span>`);
    const note = it.crossings ? describeCrossings(it.crossings) : e.note;
    $(".meta", el).textContent = it.savedMetres > 0 ? `${note} · saves ${formatDistance(it.savedMetres)}` : note;
    el.addEventListener("click", () => selectRoute(it.engine));
    return el;
  }));
}

// ---------- points ----------
function setPoint(key, p, { label } = {}) {
  state[key] = p ? { lat: p.lat, lng: p.lng, label: label || p.label || coordLabel(p) } : null;
  $(`#q${key}`).value = state[key] ? state[key].label : "";
  updateRoutes();
}

function renderPins() {
  for (const key of ["a", "b"]) {
    const p = state[key];
    if (!p) {
      if (markers[key]) { layers.pins.removeLayer(markers[key]); delete markers[key]; }
      continue;
    }
    if (!markers[key]) {
      markers[key] = L.marker([p.lat, p.lng], { icon: pinIcon(key), draggable: true, autoPan: true })
        .on("dragend", (ev) => {
          const ll = ev.target.getLatLng();
          setPoint(key, { lat: ll.lat, lng: ll.lng });
        })
        .addTo(layers.pins);
    } else {
      markers[key].setLatLng([p.lat, p.lng]);
    }
  }
}

map.on("click", (ev) => {
  const p = { lat: ev.latlng.lat, lng: ev.latlng.lng };
  setPoint(state.a ? "b" : "a", p);
});

$("#swap").addEventListener("click", () => {
  [state.a, state.b] = [state.b, state.a];
  $("#qa").value = state.a ? state.a.label : "";
  $("#qb").value = state.b ? state.b.label : "";
  updateRoutes();
});

$("#locate").addEventListener("click", () => {
  if (!navigator.geolocation) return alert("Location is not available in this browser.");
  $("#locate").disabled = true;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      $("#locate").disabled = false;
      const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      setPoint("a", p, { label: "My location" });
      if (!state.b) map.setView([p.lat, p.lng], 17);
    },
    (err) => { $("#locate").disabled = false; alert(`Could not get your location: ${err.message}`); },
    { enableHighAccuracy: true, timeout: 10000 },
  );
});

// ---------- search boxes ----------
for (const box of document.querySelectorAll(".search")) {
  const key = box.dataset.point;
  const input = $("input", box);
  const list = $(".results", box);
  let timer = 0, seq = 0, items = [], active = -1;

  const close = () => { list.hidden = true; active = -1; };
  const choose = (i) => {
    const it = items[i];
    if (!it) return;
    close();
    setPoint(key, it, { label: it.label });
    if (!(state.a && state.b)) map.setView([it.lat, it.lng], 17);
  };
  const highlight = () => list.querySelectorAll("li").forEach((li, i) => li.classList.toggle("active", i === active));

  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) return close();
    timer = setTimeout(async () => {
      const mine = ++seq;
      try {
        items = await searchPlace(q);
      } catch {
        items = [];
      }
      if (mine !== seq) return;
      list.replaceChildren(...(items.length ? items : [{ label: "No matches" }]).map((it, i) => {
        const li = document.createElement("li");
        li.textContent = it.label;
        if (it.sub) { const s = document.createElement("small"); s.textContent = it.sub; li.append(s); }
        if (items.length) li.addEventListener("mousedown", (ev) => { ev.preventDefault(); choose(i); });
        return li;
      }));
      active = -1;
      list.hidden = false;
    }, 250);
  });
  input.addEventListener("keydown", (ev) => {
    if (list.hidden || !items.length) return;
    if (ev.key === "ArrowDown") { active = (active + 1) % items.length; highlight(); ev.preventDefault(); }
    else if (ev.key === "ArrowUp") { active = (active - 1 + items.length) % items.length; highlight(); ev.preventDefault(); }
    else if (ev.key === "Enter") { choose(active < 0 ? 0 : active); ev.preventDefault(); }
    else if (ev.key === "Escape") close();
  });
  input.addEventListener("blur", () => {
    close();
    // Clearing the box clears the point.
    if (!input.value.trim() && state[key]) setPoint(key, null);
    else if (state[key]) input.value = state[key].label;
  });
}

// ---------- known shortcuts overlay ----------
let passageTimer = 0;
async function updatePassages() {
  const status = $("#passage-status");
  const c = map.getCenter();
  $("#osm-edit").href = osmEditUrl(c.lat, c.lng);
  if (!$("#passages").checked) {
    layers.passages.clearLayers();
    state.passageKey = "";
    status.textContent = "";
    return;
  }
  if (map.getZoom() < PASSAGE_MIN_ZOOM) {
    layers.passages.clearLayers();
    state.passageKey = "";
    status.textContent = `Zoom in closer to see void-deck passages and covered linkways.`;
    return;
  }
  // Query a padded box, and skip if the view is still inside the last one.
  const view = map.getBounds();
  if (state.passageBounds && state.passageBounds.contains(view)) return;
  const walk = state.walkData;
  // The Shortcut router's download already holds every mapped path, so while the map is centred on it,
  // reuse it instead of sending a second request to the same busy servers.
  const centre = map.getCenter();
  const fromWalk = walk && bboxContains(walk.bbox, { s: centre.lat, n: centre.lat, w: centre.lng, e: centre.lng });
  if (!fromWalk && state.walkFetch) { status.textContent = "Loading known shortcuts…"; return; }
  const pad = fromWalk ? L.latLngBounds([walk.bbox.s, walk.bbox.w], [walk.bbox.n, walk.bbox.e]) : view.pad(0.5);
  const bbox = { s: pad.getSouth(), w: pad.getWest(), n: pad.getNorth(), e: pad.getEast() };
  const key = JSON.stringify(bbox);
  state.passageKey = key;
  status.textContent = "Loading known shortcuts…";
  try {
    if (state.passageCtrl) state.passageCtrl.abort();
    const ctrl = (state.passageCtrl = new AbortController());
    const passages = parsePassages(fromWalk ? walkPassageElements(walk.raw) : await fetchPassages(bbox, ctrl.signal));
    if (state.passageKey !== key) return;
    state.passageBounds = pad;
    layers.passages.clearLayers();
    const color = css("--passage");
    for (const p of passages) {
      L.polyline(p.coords, { color, weight: 4, dashArray: "4 6", opacity: 0.9, interactive: true })
        .bindTooltip(p.name ? `${p.kind}: ${p.name}` : p.kind, { sticky: true })
        .addTo(layers.passages);
    }
    status.textContent = passages.length
      ? `${passages.length} passage${passages.length === 1 ? "" : "s"} mapped around here (dashed).`
      : "No passages mapped around here yet. If you know one, add it to OpenStreetMap.";
  } catch (err) {
    if (state.passageKey !== key || err.message === "cancelled") return;
    // Overpass servers refuse the "null" origin that file:// pages send.
    status.textContent = location.protocol === "file:"
      ? "Shortcut overlay needs the page served over http (see README); routes still work."
      : `Could not load shortcuts (${err.message}). Overpass may be busy, so pan to retry.`;
  }
}
map.on("moveend", () => { clearTimeout(passageTimer); passageTimer = setTimeout(updatePassages, 400); });
$("#passages").addEventListener("change", () => { state.passageBounds = null; updatePassages(); });

for (const id of ["#cut-hdb", "#cut-mall"]) {
  const box = $(id);
  try { const v = localStorage.getItem(`walk:${id}`); if (v !== null) box.checked = v === "1"; } catch {}
  box.addEventListener("change", () => {
    try { localStorage.setItem(`walk:${id}`, box.checked ? "1" : "0"); } catch {}
    updateRoutes();
  });
}

// ---------- weather ----------
// NEA's 2-hour forecast (data.gov.sg, no key, CORS open). It only adds a warning: routes never change for rain.
const FORECAST_URL = "https://api-open.data.gov.sg/v2/real-time/api/two-hr-forecast";
const FORECAST_TTL_MS = 10 * 60 * 1000;   // NEA updates every 30 min or so
const forecastCache = { promise: null, at: 0 };

function getForecast() {
  if (!forecastCache.promise || Date.now() - forecastCache.at > FORECAST_TTL_MS) {
    forecastCache.at = Date.now();
    forecastCache.promise = getJson(FORECAST_URL, { signal: AbortSignal.timeout(8000) }).catch(() => null);
  }
  return forecastCache.promise;
}

// The worst forecast among the areas the walk's start, middle and end fall in.
async function weatherForWalk(a, b) {
  const mid = { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
  return forecastFor(await getForecast(), [a, mid, b]);
}

async function renderWeather() {
  const box = $("#weather");
  const { a, b } = state;
  if (!(a && b)) { box.hidden = true; return; }
  const w = await weatherForWalk(a, b);
  if (state.a !== a || state.b !== b) return;
  state.weather = w;
  if (!w) { box.hidden = true; return; }
  const r = state.routes.find((x) => x.engine === "shortcut");
  const shelter = r && r.legs ? shelterSummary(r, routeSteps(r)) : null;
  const when = w.period ? `, ${w.period}` : "";
  let text;
  if (w.rain) {
    text = `🌧 ${w.forecast} forecast for ${w.area}${when}.`;
    if (shelter) {
      text += ` The Shortcut route is ${shelter.pct}% sheltered`;
      text += shelter.longestOpen.length
        ? `; the longest open stretches are ${shelter.longestOpen.map((o) => `the ${o.label} (${o.metres} m)`).join(" and ")}. Bring an umbrella.`
        : ".";
    }
  } else {
    text = `${w.forecast} in ${w.area}${when}.`;
    if (shelter) text += ` Shortcut route is ${shelter.pct}% sheltered.`;
  }
  box.textContent = text;
  box.classList.toggle("rain", w.rain);
  box.hidden = false;
}

// ---------- directions ----------
// The router's steps show at once. Shortly after a route settles, the same facts go to /api/directions
// (tools/serve.py), which asks the OpenCode model to reword them, and the plain-English version replaces
// the steps. The model never sees the map, so it can't change the route. The key stays on the local server.
// When rain is forecast, the facts say so and mark each step sheltered or not, so the wording can warn.
const AI_DELAY_MS = 700;          // wait for the route to settle (pin drags, late engines) before asking
const aiDirections = new Map();   // route key + rain/dry -> lines from the model
const aiNote = "Reworded by AI from the router's steps. Void decks and malls are assumed open, so check the parts that go through buildings.";
const ai = {
  timer: 0,
  ctrl: null,
  off: false,       // no AI on this server (plain http.server, or no key): stop asking
  view: "ai",       // "ai" or "steps": which version the toggle shows
};

const routeKey = (r) => `${r.metres}|${r.coords[0]}|${r.coords[r.coords.length - 1]}|${r.coords.length}`;
// Rain changes the wording, so a dry and a wet version are kept apart.
const aiKey = (dir, w) => `${dir.key}|${w && w.rain ? "rain" : "dry"}`;

function renderDirections() {
  const r = state.routes.find((x) => x.engine === "shortcut");
  const box = $("#directions");
  if (!r || !r.legs) {
    box.hidden = true;
    state.directions = null;
    clearTimeout(ai.timer);
    return;
  }
  const key = routeKey(r);
  if (state.directions && state.directions.key === key) return;
  state.directions = { key, steps: routeSteps(r), route: r };
  box.hidden = false;
  showDirections();
  if (!ai.off) {
    clearTimeout(ai.timer);
    if (ai.ctrl) ai.ctrl.abort();
    ai.timer = setTimeout(() => requestAiDirections(key), AI_DELAY_MS);
  }
}

// Shows the AI version when there is one (and the toggle allows), else the router's steps.
function showDirections(status) {
  const dir = state.directions;
  if (!dir) return;
  const lines = aiDirections.get(aiKey(dir, state.weather));
  const useAi = lines && ai.view === "ai";
  const ol = $("#steps");
  ol.classList.toggle("ai", !!useAi);
  const items = useAi ? lines : stepSentences(dir.steps);
  ol.replaceChildren(...items.map((text, i) => {
    const li = document.createElement("li");
    li.textContent = text;
    if (!useAi && dir.steps[i].inside) li.classList.add("inside");
    if (useAi && /^total:/i.test(text)) li.classList.add("total");
    if (useAi && /^rain:/i.test(text)) li.classList.add("rain");
    return li;
  }));
  const toggle = $("#ai-toggle");
  toggle.hidden = !lines;
  toggle.textContent = useAi ? "Detailed steps" : "✨ Plain English";
  $("#dir-status").textContent = status !== undefined ? status : useAi ? aiNote : "";
}

async function fetchAiDirections(facts, signal) {
  let res;
  try {
    res = await fetch("api/directions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ facts }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(50000)]),
    });
  } catch (err) {
    if (signal.aborted) throw err;
    throw new Error(err.name === "TimeoutError" ? "The AI took too long, so showing the router's steps." : "Could not reach the local server.");
  }
  const body = await res.json().catch(() => null);
  // A plain static server (python -m http.server) has no /api/directions; 503 means no key on the server.
  if (res.status === 404 || res.status === 501 || res.status === 503 || !body) {
    const err = new Error(body && body.error ? body.error : "Run python tools/serve.py for plain-English directions.");
    err.unavailable = true;
    throw err;
  }
  if (!res.ok) throw new Error(body.error || `Server error ${res.status}`);
  const lines = parseNumberedList(body.text);
  if (!lines.length) throw new Error("The AI returned no steps.");
  return lines;
}

async function requestAiDirections(key) {
  const dir = state.directions;
  if (!dir || dir.key !== key || ai.off) return;
  const ctrl = (ai.ctrl = new AbortController());
  // Wait for the forecast (cached, at most 8 s) so a wet walk gets the rain warning in its wording.
  const w = await weatherForWalk(state.a, state.b);
  if (ctrl.signal.aborted || !state.directions || state.directions.key !== key) return;
  state.weather = w;
  const k = aiKey(dir, w);
  if (aiDirections.has(k)) { showDirections(); return; }
  showDirections("Writing plain-English directions…");
  try {
    const facts = directionsFacts(dir.route, dir.steps, state.a.label, state.b.label, w);
    aiDirections.set(k, await fetchAiDirections(facts, ctrl.signal));
    if (state.directions && state.directions.key === key) showDirections();
  } catch (err) {
    if (ctrl.signal.aborted) return;   // a newer route took over
    if (err.unavailable) ai.off = true;
    // On a static host (GitHub Pages) there is no serve.py: just keep the router's steps, without a hint
    // that only makes sense to whoever runs the app locally.
    const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
    const msg = err.unavailable && !local ? "" : err.message;
    if (state.directions && state.directions.key === key) showDirections(msg);
  } finally {
    if (ai.ctrl === ctrl) ai.ctrl = null;
  }
}

$("#ai-toggle").addEventListener("click", () => {
  ai.view = ai.view === "ai" ? "steps" : "ai";
  showDirections();
});

// ---------- OneMap token ----------
$("#token").value = loadToken();
$("#save-token").addEventListener("click", () => {
  saveToken($("#token").value.trim());
  $("#save-token").textContent = "Saved";
  setTimeout(() => ($("#save-token").textContent = "Save"), 1200);
  updateRoutes();
});

// ---------- hash state ----------
function syncHash() {
  const h = buildHash(state.a, state.b);
  if (location.hash.replace(/^#/, "") !== h) history.replaceState(null, "", h ? `#${h}` : location.pathname + location.search);
}
function loadHash() {
  const { a, b } = parseHash(location.hash);
  state.a = a ? { ...a, label: coordLabel(a) } : null;
  state.b = b ? { ...b, label: coordLabel(b) } : null;
  $("#qa").value = state.a ? state.a.label : "";
  $("#qb").value = state.b ? state.b.label : "";
  if (state.a && !state.b) map.setView([state.a.lat, state.a.lng], 17);
  updateRoutes();
}
window.addEventListener("hashchange", loadHash);

// ---------- utils ----------
function errorText(engine, err) {
  const msg = (err && err.message) || "Failed";
  // Overpass servers refuse the "null" origin that file:// pages send.
  if (engine === "shortcut" && location.protocol === "file:" && msg === "Failed to fetch") return "Needs the page served over http (see README)";
  if (engine === "shortcut" && /Failed to fetch|HTTP (429|50\d)|timed out|abort/i.test(msg)) return "OSM map servers are busy. Drag a pin or toggle a box to retry.";
  return msg;
}
function titleCase(s) {
  return String(s || "").toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
}
function coordLabel(p) {
  return `Pin ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
}
function paddingForPanel() {
  return innerWidth > 720 ? [440, 40] : [40, innerHeight * 0.6];
}

tileIndex();
loadHash();
updatePassages();
