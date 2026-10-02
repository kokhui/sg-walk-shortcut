"""Build offline walk-data tiles for the Shortcut router from an OpenStreetMap extract.

    python -m pip install --user osmium
    curl -o singapore-latest.osm.pbf https://download.openstreetmap.fr/extracts/asia/singapore-latest.osm.pbf
    python tools/build_tiles.py singapore-latest.osm.pbf

Writes tiles/index.json and tiles/<ty>_<tx>.json (0.01 degree tiles, about 1.1 km). It keeps the same
features that buildWalkQuery() in router.js asks Overpass for, so either source feeds the same router.
Tile format (decoded by decodeTile() in lib.js):
  t  tag table, each entry a dict; elements refer to it by index
  ni/na/no  node ids, lat*1e6 and lon*1e6, each delta-encoded, sorted by id
  w  walkable ways: [way id, tag index, [node index, ...]]
  g  areas and barrier lines: [id, tag index, [lat0, lon0, dlat, dlon, ...]] (1e6 ints)
"""
import json
import math
import os
import re
import sys
import time

import osmium

TILE = 0.01
BBOX = (1.15, 103.59, 1.48, 104.10)  # s, w, n, e: Singapore
WALK_HIGHWAYS = set("footway path pedestrian steps corridor living_street residential service unclassified road track "
                    "cycleway tertiary tertiary_link secondary secondary_link primary primary_link".split())
BARRIER_HIGHWAYS = {"motorway", "motorway_link", "trunk", "trunk_link"}
BUILDINGS = {"residential", "apartments", "commercial", "retail", "public", "train_station"}
PRIVATE = re.compile(r"^(private|no)$")


def tile_of(lat, lon):
    return math.floor(lat / TILE + 1e-9), math.floor(lon / TILE + 1e-9)


def tiles_for(points):
    lats = [p[0] for p in points]
    lons = [p[1] for p in points]
    (y0, x0), (y1, x1) = tile_of(min(lats), min(lons)), tile_of(max(lats), max(lons))
    return [(y, x) for y in range(y0, y1 + 1) for x in range(x0, x1 + 1)]


def inside(points):
    s, w, n, e = BBOX
    return any(s <= la <= n and w <= lo <= e for la, lo in points)


def is_passage(t):
    return t.get("tunnel") == "building_passage" or t.get("highway") == "corridor" or (
        t.get("covered") == "yes" and t.get("highway") in ("footway", "path", "pedestrian", "steps"))


class Builder(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.tiles = {}
        self.tags = {}
        self.counts = {"walk": 0, "building": 0, "private": 0, "barrier": 0}

    def tile(self, key):
        if key not in self.tiles:
            self.tiles[key] = {"nodes": {}, "w": [], "g": []}
        return self.tiles[key]

    def tag_index(self, d):
        k = json.dumps(d, sort_keys=True, ensure_ascii=False)
        if k not in self.tags:
            self.tags[k] = len(self.tags)
        return self.tags[k]

    def add_geom(self, gid, tags, pts):
        if len(pts) < 2 or not inside(pts):
            return False
        ti = self.tag_index(tags)
        for key in tiles_for(pts):
            self.tile(key)["g"].append((gid, ti, pts))
        return True

    def way(self, w):
        t = {k: v for k, v in w.tags}
        hw = t.get("highway")
        try:
            refs = [(n.ref, n.lat, n.lon) for n in w.nodes]
        except osmium.InvalidLocationError:
            return
        pts = [(la, lo) for _, la, lo in refs]
        over_under = t.get("bridge") == "yes" or t.get("tunnel") in ("yes", "culvert")

        if hw in WALK_HIGHWAYS and not PRIVATE.match(t.get("foot", "")) and not PRIVATE.match(t.get("access", "")):
            if len(refs) < 2 or not inside(pts):
                return
            keep = {"highway": hw}
            for k in ("bridge", "tunnel", "covered", "name"):
                if k in t:
                    keep[k] = t[k]
            if t.get("footway") == "crossing":  # for "cross at the crossing" in directions
                keep["footway"] = "crossing"
            ti = self.tag_index(keep)
            for key in tiles_for(pts):
                tl = self.tile(key)
                for ref, la, lo in refs:
                    tl["nodes"][ref] = (la, lo)
                tl["w"].append((w.id, ti, [r for r, _, _ in refs]))
            self.counts["walk"] += 1
            return

        # Lines a building crossing may not cut. Negative ids keep them apart from area ids.
        if over_under:
            return
        keep = None
        if t.get("waterway") in ("river", "canal", "stream", "drain"):
            keep = {"waterway": t["waterway"]}
        elif t.get("barrier") in ("fence", "wall", "retaining_wall"):
            keep = {"barrier": t["barrier"]}
        elif hw in BARRIER_HIGHWAYS:
            keep = {"highway": hw}
        if keep and self.add_geom(-w.id, keep, pts):
            self.counts["barrier"] += 1

    def area(self, a):
        t = {k: v for k, v in a.tags}
        b = t.get("building")
        is_building = b in BUILDINGS or t.get("shop") == "mall" or (
            b is not None and t.get("amenity") in ("marketplace", "food_court"))
        is_private = "landuse" in t and PRIVATE.match(t.get("access", "")) and not b
        if not (is_building or is_private):
            return
        try:
            ring = max((list(r) for r in a.outer_rings()), key=len)
            pts = [(n.lat, n.lon) for n in ring]
        except (osmium.InvalidLocationError, ValueError):
            return
        if is_private:
            keep = {"landuse": t["landuse"], "access": t["access"]}
        else:
            keep = {"building": b or "yes"}
            for k in ("shop", "amenity", "residential", "addr:housenumber"):
                if k in t:
                    keep[k] = t[k]
            if "name" in t and b not in ("residential", "apartments"):
                keep["name"] = t["name"]
        if self.add_geom(a.id, keep, pts):
            self.counts["private" if is_private else "building"] += 1


def e6(v):
    return round(v * 1e6)


def encode(tl):
    ids = sorted(tl["nodes"])
    pos = {nid: i for i, nid in enumerate(ids)}
    ni, na, no = [], [], []
    pid = pla = plo = 0
    for nid in ids:
        la, lo = e6(tl["nodes"][nid][0]), e6(tl["nodes"][nid][1])
        ni.append(nid - pid); na.append(la - pla); no.append(lo - plo)
        pid, pla, plo = nid, la, lo
    w = [[wid, ti, [pos[r] for r in refs]] for wid, ti, refs in tl["w"]]
    g = []
    for gid, ti, pts in tl["g"]:
        flat, pla, plo = [], 0, 0
        for la, lo in pts:
            la, lo = e6(la), e6(lo)
            flat += [la - pla, lo - plo]
            pla, plo = la, lo
        g.append([gid, ti, flat])
    return {"ni": ni, "na": na, "no": no, "w": w, "g": g}


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    src = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tiles")
    t0 = time.time()
    h = Builder()
    h.apply_file(src, locations=True)
    print(f"parsed in {time.time() - t0:.0f}s: {h.counts}")

    os.makedirs(out, exist_ok=True)
    for f in os.listdir(out):
        if f.endswith(".json"):
            os.remove(os.path.join(out, f))
    tag_table = [json.loads(k) for k, _ in sorted(h.tags.items(), key=lambda kv: kv[1])]
    total = 0
    names = []
    for (ty, tx), tl in sorted(h.tiles.items()):
        if not tl["w"] and not tl["g"]:
            continue
        doc = encode(tl)
        used = sorted({e[1] for e in doc["w"]} | {e[1] for e in doc["g"]})
        remap = {old: new for new, old in enumerate(used)}
        doc["t"] = [tag_table[i] for i in used]
        for e in doc["w"] + doc["g"]:
            e[1] = remap[e[1]]
        name = f"{ty}_{tx}"
        with open(os.path.join(out, name + ".json"), "w", encoding="utf-8") as fh:
            json.dump(doc, fh, separators=(",", ":"), ensure_ascii=False)
        total += os.path.getsize(os.path.join(out, name + ".json"))
        names.append(name)
    index = {
        "built": time.strftime("%Y-%m-%d"),
        "source": os.path.basename(src),
        "tile": TILE,
        "bbox": BBOX,
        "tiles": names,
    }
    with open(os.path.join(out, "index.json"), "w", encoding="utf-8") as fh:
        json.dump(index, fh, separators=(",", ":"))
    print(f"wrote {len(names)} tiles, {total / 1e6:.1f} MB, to {out} in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
