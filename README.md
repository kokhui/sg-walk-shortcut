# 步行 (SG Walk Shortcut), by 两兄弟

Google Maps walking directions often keep to roads and miss the shortcuts you actually take through HDB void decks, covered linkways and building passages. This static web app asks routers built on OpenStreetMap data, which do know many of those passages, and shows their routes side by side with distance and walking time.

## Run

```
python tools/serve.py
# landing page: http://127.0.0.1:8731/
# the app:      http://127.0.0.1:8731/app.html
```

`index.html` is the landing page: team 两兄弟, app 步行, the problem, who it's for, results and features. Its screenshot is `demo1.png`. Old shared links of the form `/#a=…&b=…` redirect to `app.html` with the same route.

`tools/serve.py` uses only the Python standard library. It serves the folder, and adds `POST /api/directions` for the AI directions (see below). It reads `OPENCODE_API_KEY` from the `OPENCODE_API_KEY` environment variable, or else from `../lunch-uncle/.env`; pass `--env <file>` to use another file. Without a key, everything except the AI directions still works.

`python -m http.server 8731 --bind 127.0.0.1` also works, without the AI directions. Opening `index.html` straight from disk doesn't work, because the browser blocks the offline tiles over `file://`.

There is no build step and no npm. Leaflet 1.9.4 is loaded from cdnjs.

## Use

- Tap the map twice to place start (A) and end (B), or search with OneMap. Drag the pins to adjust.
- The cards compare routes. **Shortest** marks the winner, and "saves X m" is measured against the longest route. Tap a card or a line to highlight it.
- Dashed purple lines are walkways OSM knows pass through or under buildings: `tunnel=building_passage`, `highway=corridor`, and footways tagged `covered=yes`. They show at zoom 16 or closer.
- **Shortcut missing?** opens the OSM editor at the map centre. Once a passage is added to OSM, both routers pick it up after their next data refresh, usually within a day or two.
- The URL hash (`#a=lat,lng&b=lat,lng`) makes a route shareable.

## Directions

The **Directions** panel lists the Shortcut route step by step: which way to turn, what you walk along (a street name, covered linkway, overhead bridge, pedestrian crossing) and which building you cut through (for example "the void deck of Blk 744" or "Aperia Mall"). The router builds these steps from the OSM names on each part of the route (`routeSteps()` and `stepSentences()` in `router.js`). They need no AI and no key.

**Plain-English directions** replace those steps automatically, about 0.7 s after a route settles: the AI rewrites them the way a local would give them, combining the obvious ones. Moving a pin cancels a rewrite still in progress, so dragging sends one request, not dozens. Each route's wording is kept, so going back to a route doesn't ask again. The **Detailed steps** button switches back to the router's own steps. If the server has no `/api/directions` (plain `http.server`) or no key, the app tries once, shows the router's steps with a hint, and stops asking. The browser sends only the step facts (`directionsFacts()` in `router.js`) to `/api/directions`. `tools/serve.py` adds its fixed prompt and asks the OpenCode Go model `glm-5.3-flash` with `reasoning_effort: "low"`. The model never sees the map, so it can only reword the route, not change it.

- **Speed:** about 2–6 s for a 1 km route with 15–19 steps. By default the model reasons at length (about 55 s), so `reasoning_effort` matters. Among the OpenCode Go models tried at low effort, it was also the fastest. The DeepSeek, Qwen and MiMo flash models took 12–32 s.
- **Key:** the OpenCode key stays in `serve.py`'s process and is never sent to the browser. The browser couldn't call OpenCode directly anyway, because the endpoint doesn't answer CORS preflights. The server only accepts route facts, so it doesn't act as an open proxy for the key.
- The panel notes that void decks and malls are assumed open, because the AI wording can't know that any better than the router does.

## Rain warning

When both pins are set, the app reads NEA's 2-hour forecast from data.gov.sg (`two-hr-forecast`, no key, CORS open, cached for 10 minutes). It uses the worst forecast among the town areas nearest the start, middle and end of the walk (`forecastFor()` in `lib.js`). **Routes never change for rain:** the shortest route is the same in any weather. The app only warns you.

- **The banner** above the cards gives the forecast and how much of the Shortcut route is under a roof. Void decks, malls, covered walkways, indoor corridors and underpasses count as sheltered (`shelterSummary()` in `router.js`). In dry weather it is one muted line, such as "Partly Cloudy in Yishun, 2.30 pm to 4.30 pm. Shortcut route is 62% sheltered." When rain, showers or thunder are forecast, it is highlighted and names the longest open stretches: "🌧 Thundery Showers forecast for Yishun... the longest open stretches are the service road (138 m) and the footpath (56 m). Bring an umbrella."
- **The AI directions** get the forecast and a sheltered flag on every step. When rain is forecast, they open with a "Rain:" line and mark which stretches are uncovered. Dry and wet wordings are cached separately.
- **Limits:** "sheltered" only counts what OSM maps as covered. Many HDB linkways are not tagged `covered=yes`, so the real figure is often higher.

## Engines

| Engine | Endpoint | Notes |
|---|---|---|
| **Shortcut** | Runs in the browser (`router.js`) on OSM data from Overpass | Can cut through HDB blocks and malls. See below. |
| Valhalla | `valhalla1.openstreetmap.de` (FOSSGIS) | `pedestrian` costing, with `walkway_factor` 0.8 so footways cost less than roadside walking |
| OSRM foot | `routing.openstreetmap.de/routed-foot` (FOSSGIS) | The router behind openstreetmap.org's walking directions |
| OneMap | `onemap.gov.sg/api/public/routingsvc` | Optional and needs a free token pasted into settings (kept in `localStorage`). This is the road-based baseline. |

Every engine's time uses one 1.3 m/s pace, so the comparison is only about path length. The public demo servers are rate-limited and best-effort, so keep this to personal use.

## Why the Shortcut router exists

In most estates, OSM maps HDB blocks and malls only as building outlines. There are no paths through void decks or mall corridors, and almost no entrances: around Toa Payoh Central, only 3 ways have indoor tags. Valhalla, OSRM and Google therefore treat those buildings as walls.

The Shortcut router downloads the walkable ways and buildings around A and B in one Overpass query. It turns them into a graph and adds **crossing edges**: for every passable building, each path node within 25 m of its outline is linked by a straight line to the others. HDB blocks usually sit 15–30 m back from the nearest mapped path, across open ground, so a 25 m reach is needed. The nodes are thinned to one every 10 m, up to 40 per building. Then it runs A* search for the shortest walk.

- **HDB blocks** are `building=residential|apartments`, assumed walkable through the void deck.
- **Malls, markets, stations and public buildings** are `shop=mall`, `building=retail|commercial|public|train_station`, and `amenity=marketplace|food_court`.
- Blocks tagged `residential=condominium`, or inside an area tagged `access=private`, are skipped as gated condos. Private roads and paths are never used.
- A cut-through may not cross a river, canal or drain, a main road (secondary and above), or a mapped fence or wall. Bridges and tunnels are fine.
- Crossings cost 5% more than mapped paths, so a mapped path wins a tie. The route is drawn dashed white where it goes through a building.

Toa Payoh example: 612 m, against 722 m from Valhalla and OSRM. CT Hub 2 to Golden Mile: 1.10 km (14 min), via the ICA Services Centre and Kampong Glam void decks, against 1.44 km from OSRM.

**Limits.** The router only knows building types, not real access. It may cut through an unmapped gated condo, a void deck walled off by ground-floor units, or a mall after closing time, so check the dashed parts. Malls mapped as multipolygons are only included from the offline tiles, not from the Overpass fallback. Walks are capped at 3.5 km apart, to keep the download size reasonable. The public Overpass servers rate-limit heavy use. If all of them are busy, the Shortcut card says so.

## Offline map data (tiles/)

The Shortcut router reads its map from `tiles/`, so routes inside Singapore don't need the Overpass servers at all, which are often rate-limited or down. All of Singapore is 980 tiles of about 1.1 km each, 28 MB in total. A route loads in about 0.1–0.3 s.

To refresh the data (OSM changes daily; monthly is plenty):

```
python -m pip install --user osmium
curl -o singapore-latest.osm.pbf https://download.openstreetmap.fr/extracts/asia/singapore-latest.osm.pbf
python -X utf8 tools/build_tiles.py singapore-latest.osm.pbf
```

The extract is about 38 MB, and the build takes about 3 minutes. `build_tiles.py` keeps the same features `buildWalkQuery()` asks Overpass for. It also includes malls mapped as multipolygons, which the Overpass query misses. If you change the router's features, change both. The page footer shows the build date. Overpass is still the fallback, used only outside the tiles' area.

## Speed

- Each route card fills in as soon as its engine answers. Valhalla and OSRM take about 1 s. The Shortcut router waits for its map-data download.
- Inside Singapore, the offline tiles are used and nothing below applies.
- **Downloads race.** If `overpass-api.de` has not answered within 3 s, or fails, the mail.ru mirror starts too, then private.coffee, and the first good answer wins. Each server gets up to 45 s.
- **Downloads are cached** in the browser (IndexedDB, 7 days, up to 20 areas). Each download covers about 200 m more than the walk needs, so a repeat walk, a dragged pin or a nearby walk skips the download: the full page loads in under 1 s, and a re-route takes about 0.1 s. Bump `CACHE_VERSION` in `app.js` whenever `buildWalkQuery` changes.
- The mapped-passages overlay reuses the Shortcut download whenever the map is centred inside it, so it doesn't send a second request.

## Files

- `tiles/` holds the offline walk data (with street names and block numbers for directions), and `tools/build_tiles.py` builds it.
- `router.js` holds the Shortcut router: graph building, building crossings and A* search. It is pure and also loads under Node.
- `lib.js` holds pure helpers: polyline decoding, response normalising, comparison, the Overpass query and URL builders. It also loads under Node for quick checks (`node -e "require('./lib.js')"`).
- `app.js` holds the map, the network calls and the UI.
- `tools/serve.py` is the local server and the AI directions proxy.
- `index.html` is the landing page, and `app.html` is the app.
- `style.css` holds the light and dark tokens, plus a bottom sheet under 720px.

## Promo video

`promo/buxing-promo.mp4` is a 54-second promo (1080p, 30 fps, no audio), and `promo/poster.png` is its thumbnail. The video runs through:

1. The title: 两兄弟 presents 步行.
2. The problem: map apps walk you around the block.
3. The fix: 步行 walks you through the buildings.
4. Two real routes with their measured distances: CT Hub 2 → Golden Mile Food Centre, 1.06 km against 1.29 km, and Yishun MRT → Chong Pang, 1.13 km against 1.39–1.50 km.
5. Plain-English directions and the rain warning.
6. A side-by-side comparison with a road-following route.
7. A closing call to action.

The footage is real app screenshots in `promo/assets/`, taken at 1920×1080. The rain shot uses a simulated forecast and is labelled as one on screen. To re-render after changing a scene, run `python tools/make_promo.py`, which needs `pillow` and `imageio-ffmpeg` and takes about 5 minutes. `--preview <seconds>` renders a single frame.

## Data and licences

- **`tiles/`** is derived from OpenStreetMap data, © OpenStreetMap contributors, and is available under the [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/). If you redistribute or change the tiles, keep this attribution and share the result under the ODbL.
- **Basemap tiles** are from [OneMap](https://www.onemap.gov.sg/), © Singapore Land Authority. **Weather** is NEA's 2-hour forecast, via [data.gov.sg](https://data.gov.sg/) under the Singapore Open Data Licence.
- **Routing services:** Valhalla and OSRM run on servers provided by [FOSSGIS](https://routing.openstreetmap.de/), and the Overpass API is a fallback.
- **Screenshots** in `demo1.png` and `promo/assets/` show OneMap and OpenStreetMap data, with their attribution visible.
- **The app's own code** has no licence file yet.

## How this was built (Claude Code skills and MCP)

The app was built with Claude Code. These are the skills and MCP servers used, and what each was for.

### MCP server: `chrome-devtools`

Used to run and check the app in a real Chrome browser, at every step:

| Tool | Used for |
|---|---|
| `new_page`, `navigate_page` | Opening the app and the landing page at `http://127.0.0.1:8731/`, including cold reloads after clearing the cache. |
| `evaluate_script` | Driving the app and measuring it: setting pins, timing each engine's card, counting Overpass and `/api/directions` requests, checking the tile cache, and simulating a rain forecast. |
| `take_screenshot` | Visual checks of routes, the Directions panel, the rain banner and the landing page. |
| `emulate` | Phone width (360–375 px), light and dark mode. |
| `list_console_messages` | Checking for JavaScript errors and failed requests after each change. |

The promo video's footage is screenshots taken with this MCP server, at a 1920×1080 viewport.

