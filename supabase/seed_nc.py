#!/usr/bin/env python3
"""Seed NC bridges from NC25.txt (FHWA NBI) into emg_bridges via PostgREST.

Usage:
    python3 seed_nc.py [--prefix PREFIX]

Parsing lives in nbi_parse.py (shared with the uploader). This script adds
the fail-closed collision check and the batched PostgREST load.
"""
from __future__ import annotations
import argparse, json, sys, urllib.request

sys.path.insert(0, "/opt/hatch/skills/skill-creator/bin")
sys.path.insert(0, "/home/hatch/workspace/emergency-bridge-app/supabase")
from dynamic_credentials import add_surrogate_to_request
from nbi_parse import parse_nbi, BRIDGE_COLS

HOST = "qyymkvjvqofcaeustqqy.supabase.co"
CRED = "custom.supabase-emergency-app"
API = f"https://{HOST}/rest/v1"
SRC = "/home/hatch/workspace/user/files/NC25.txt"
BATCH = 400


def api_get(path, query=""):
    url = f"{API}{path}" + ("?" + query if query else "")
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    add_surrogate_to_request(req, CRED, allowed_hosts=[HOST])
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode())


def api_post(table, rows):
    # PostgREST wants geom EWKT under key "geom", not "geom_ewkt"
    payload = []
    for x in rows:
        rec = {c: x.get(c) for c in BRIDGE_COLS}
        rec["asset_id"] = x["asset_id"]
        rec["state"] = x["state"]
        rec["geom"] = x["geom_ewkt"]
        payload.append(rec)
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        f"{API}/{table}", data=body, method="POST",
        headers={"Content-Type": "application/json", "Prefer": "return=minimal"})
    add_surrogate_to_request(req, CRED, allowed_hosts=[HOST])
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.status


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prefix", default=None,
                    help="prefix asset_ids as '<PREFIX>-<id>' for cross-state uniqueness")
    args = ap.parse_args()

    with open(SRC) as f:
        text = f.read()
    res = parse_nbi(text, "NC", args.prefix)
    rows = res["rows"]
    print(f"parsed {res['total_records']} rows -> {len(rows)} loadable, "
          f"{res['skipped_coords']} skipped (bad coords/fields)")

    # --- collision check (fail closed) ---
    new_ids = [x["asset_id"] for x in rows]
    if len(set(new_ids)) != len(new_ids):
        print("ABORT: duplicate asset_ids within NC batch", file=sys.stderr)
        sys.exit(1)
    existing = set()
    offset = 0
    while True:
        got = api_get("/emg_bridges", f"select=asset_id&limit=2000&offset={offset}")
        if not got:
            break
        existing.update(x["asset_id"] for x in got)
        offset += len(got)
    collisions = [a for a in new_ids if a in existing]
    if collisions:
        print(f"ABORT: {len(collisions)} asset_id collisions with existing rows "
              f"(e.g. {collisions[:8]}). Re-run with --prefix NC.",
              file=sys.stderr)
        sys.exit(1)
    print(f"collision check passed against {len(existing)} existing rows")

    n = 0
    for i in range(0, len(rows), BATCH):
        api_post("emg_bridges", rows[i:i + BATCH])
        n += min(BATCH, len(rows) - i)
        print(f"  ... {n}/{len(rows)}", flush=True)
    print(f"NC bridges loaded: {n}")


if __name__ == "__main__":
    main()
