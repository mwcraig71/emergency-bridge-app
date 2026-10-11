#!/usr/bin/env python3
"""Seed emg_bridges + emg_districts from the local GeoJSON files via PostgREST.

Usage: python3 seed_bridges.py [--bridges-only | --districts-only]
"""
from __future__ import annotations
import json, sys, urllib.request, urllib.parse

sys.path.insert(0, "/opt/hatch/skills/skill-creator/bin")
sys.path.insert(0, "/home/hatch/workspace/emergency-bridge-app/supabase")
from dynamic_credentials import add_surrogate_to_request
from nbi_parse import BRIDGE_COLS, clean  # shared cleaning/type coercion

HOST = "qyymkvjvqofcaeustqqy.supabase.co"
CRED = "custom.supabase-emergency-app"
API = f"https://{HOST}/rest/v1"
BATCH = 400

def post(table, rows):
    body = json.dumps(rows).encode()
    req = urllib.request.Request(f"{API}/{table}", data=body, method="POST",
        headers={"Content-Type": "application/json", "Prefer": "return=minimal"})
    add_surrogate_to_request(req, CRED, allowed_hosts=[HOST])
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.status

def load_bridges():
    with open("/home/hatch/workspace/webmap-data/bridges_full.geojson") as f:
        feats = json.load(f)["features"]
    rows, n = [], 0
    for ft in feats:
        p, g = ft["properties"], ft["geometry"]
        lon, lat = g["coordinates"]
        row = {c: clean(c, p.get(c)) for c in BRIDGE_COLS}
        row["asset_id"] = clean("asset_id", p.get("asset_id"))
        row["geom"] = f"SRID=4326;POINT({lon} {lat})"
        rows.append(row)
        if len(rows) >= BATCH:
            post("emg_bridges", rows); n += len(rows); rows = []
            print(f"  ... {n}/{len(feats)}", flush=True)
    if rows:
        post("emg_bridges", rows); n += len(rows)
    print(f"bridges loaded: {n}")

def load_districts():
    with open("/home/hatch/workspace/webmap-data/districts.geojson") as f:
        feats = json.load(f)["features"]
    rows = []
    for ft in feats:
        p = ft["properties"]
        rows.append({
            "id": str(p.get("district") or p.get("id") or p.get("dist_label")),
            "dist_label": p.get("dist_label") or f"District {p.get('district')}",
            "geom": f"SRID=4326;{geom_to_wkt(ft['geometry'])}",
        })
    post("emg_districts", rows)
    print(f"districts loaded: {len(rows)}")

def geom_to_wkt(g):
    t, c = g["type"], g["coordinates"]
    if t == "Polygon":
        # promote to MultiPolygon to match the column type
        polys = "(" + ",".join("(" + ",".join(f"{x} {y}" for x, y in r) + ")" for r in c) + ")"
        return f"MULTIPOLYGON({polys})"
    if t == "MultiPolygon":
        polys = ",".join("(" + ",".join("(" + ",".join(f"{x} {y}" for x, y in r) + ")" for r in p) + ")" for p in c)
        return f"MULTIPOLYGON({polys})"
    raise ValueError(f"unexpected geom type {t}")

if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "all"
    if mode in ("all", "districts-only"):
        print("loading districts..."); load_districts()
    if mode in ("all", "bridges-only"):
        print("loading bridges..."); load_bridges()
    print("done")
