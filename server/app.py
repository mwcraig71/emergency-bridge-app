#!/usr/bin/env python3
"""Emergency Bridge Inspection — dashboard backend.

Single Render web service: serves the built SPA (app/dist) AND the NBI
import API. Python stdlib only, no dependencies.

API (all JSON unless noted):
  POST /api/nbi/preview?state=XX&filename=..&prefix=YY   (raw file bytes in body)
      -> {parse_id, format, layout_verified, total_records, loadable,
          skipped_coords, districts, bbox, sample_rows}
  POST /api/nbi/check?parse_id=..      -> {collisions[<=50], collision_count,
                                           within_batch_duplicates, existing_count}
  POST /api/nbi/import?parse_id=..&imported_by=..
      -> {job_id, status:'started'}   (fail-closed: aborts on any collision)
  GET  /api/nbi/jobs/<job_id>         -> {status, done, total, loaded, skipped, error}
  GET  /api/nbi/imports                -> [{emg_imports rows, newest first}]

Auth: if IMPORT_TOKEN env is set, every /api/nbi/* request must carry the
same value in the x-import-token header. Set it in Render env vars.

Supabase: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY env vars (service_role
never leaves this server; the browser bundle only ever sees the anon key).
"""
from __future__ import annotations

import json
import mimetypes
import os
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "supabase"))
from nbi_parse import parse_nbi, BRIDGE_COLS  # noqa: E402

SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://qyymkvjvqofcaeustqqy.supabase.co").rstrip("/")
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
IMPORT_TOKEN = os.environ.get("IMPORT_TOKEN", "")
DIST_DIR = os.path.join(os.path.dirname(__file__), "..", "app", "dist")
BATCH = 400
MAX_PARSES = 3

PARSES: dict = {}   # parse_id -> {"rows": [...], "meta": {...}, "ts": float}
JOBS: dict = {}     # job_id -> {"status":..., "done":int, "total":int, ...}
_seq = [0]
_lock = threading.Lock()


def _next(prefix):
    with _lock:
        _seq[0] += 1
        return f"{prefix}_{_seq[0]}_{int(time.time())}"


def sb_req(method, path, query="", body=None):
    url = f"{SUPABASE_URL}/rest/v1{path}" + ("?" + query if query else "")
    headers = {"Accept": "application/json", "apikey": SERVICE_KEY}
    if body is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=120) as r:
        raw = r.read().decode()
        return json.loads(raw) if raw else None


def sb_insert(table, rows):
    payload = []
    for x in rows:
        rec = {c: x.get(c) for c in BRIDGE_COLS}
        rec["asset_id"] = x["asset_id"]
        rec["state"] = x["state"]
        rec["geom"] = x["geom_ewkt"]
        payload.append(rec)
    sb_req("POST", f"/{table}", "",
           body=json.dumps(payload).encode())


def existing_asset_ids():
    out, offset = set(), 0
    while True:
        got = sb_req("GET", "/emg_bridges",
                     f"select=asset_id&limit=2000&offset={offset}") or []
        if not got:
            break
        out.update(x["asset_id"] for x in got)
        offset += len(got)
    return out


def insert_import_log(entry):
    url = f"{SUPABASE_URL}/rest/v1/emg_imports"
    req = urllib.request.Request(
        url, data=json.dumps([entry]).encode(), method="POST",
        headers={"Accept": "application/json", "apikey": SERVICE_KEY,
                 "Content-Type": "application/json",
                 "Prefer": "return=minimal"})
    with urllib.request.urlopen(req, timeout=60):
        pass


def run_import(job_id, parse_id, state, filename, imported_by, fmt):
    job = JOBS[job_id]
    try:
        parse = PARSES.get(parse_id)
        if not parse:
            raise RuntimeError("parse expired; re-upload the file")
        # Pre-flight: import log table must exist (migration 005). Fail
        # BEFORE inserting anything so a load is never left unlogged.
        try:
            sb_req("GET", "/emg_imports", "select=id&limit=1")
        except Exception:
            raise RuntimeError("emg_imports table missing — run migration "
                               "005_emg_imports.sql in the SQL editor first")
        rows = parse["rows"]
        # Fail closed: re-check collisions at import time.
        new_ids = [x["asset_id"] for x in rows]
        if len(set(new_ids)) != len(new_ids):
            raise RuntimeError("duplicate asset_ids within batch")
        existing = existing_asset_ids()
        collisions = [a for a in new_ids if a in existing]
        job["existing_count"] = len(existing)
        if collisions:
            job.update(status="aborted", error=f"{len(collisions)} collisions",
                       collisions=collisions[:50])
            insert_import_log({
                "state": state, "filename": filename, "imported_by": imported_by,
                "format": fmt, "total_records": parse["meta"]["total_records"],
                "loaded": 0, "skipped_coords": parse["meta"]["skipped_coords"],
                "collisions": len(collisions), "status": "aborted",
                "notes": f"e.g. {', '.join(collisions[:5])}"})
            return
        n = 0
        for i in range(0, len(rows), BATCH):
            sb_insert("emg_bridges", rows[i:i + BATCH])
            n += min(BATCH, len(rows) - i)
            job["done"] = n
        job.update(status="completed", loaded=n)
        insert_import_log({
            "state": state, "filename": filename, "imported_by": imported_by,
            "format": fmt, "total_records": parse["meta"]["total_records"],
            "loaded": n, "skipped_coords": parse["meta"]["skipped_coords"],
            "collisions": 0, "status": "completed", "notes": None})
    except Exception as e:  # noqa: BLE001 - surfaced to the job poller
        job.update(status="failed", error=str(e)[:500])
        try:
            insert_import_log({
                "state": state, "filename": filename, "imported_by": imported_by,
                "format": fmt, "total_records": 0, "loaded": job.get("done", 0),
                "skipped_coords": 0, "collisions": 0, "status": "failed",
                "notes": str(e)[:500]})
        except Exception:
            pass


class Handler(BaseHTTPRequestHandler):
    server_version = "emg-import/1.0"

    def log_message(self, *a):
        pass  # quiet; Render captures stdout anyway

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers",
                         "Content-Type, x-import-token")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self):
        if not IMPORT_TOKEN:
            return True
        return self.headers.get("x-import-token") == IMPORT_TOKEN

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path, qs = parsed.path, urllib.parse.parse_qs(parsed.query)
        if path == "/api/nbi/imports":
            if not self._authorized():
                return self._json(401, {"error": "unauthorized"})
            try:
                rows = sb_req("GET", "/emg_imports",
                              "select=*&order=imported_at.desc&limit=50") or []
                return self._json(200, rows)
            except Exception as e:  # noqa: BLE001
                return self._json(500, {"error": str(e)[:300]})
        if path.startswith("/api/nbi/jobs/"):
            job_id = path.rsplit("/", 1)[-1]
            job = JOBS.get(job_id)
            if not job:
                return self._json(404, {"error": "unknown job"})
            return self._json(200, {"job_id": job_id, **job})
        # static SPA
        return self._serve_static(path)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path, qs = parsed.path, urllib.parse.parse_qs(parsed.query)
        if not path.startswith("/api/nbi/"):
            return self._json(404, {"error": "not found"})
        if not self._authorized():
            return self._json(401, {"error": "unauthorized"})
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""

        if path == "/api/nbi/preview":
            state = (qs.get("state") or [""])[0].upper()
            filename = (qs.get("filename") or ["upload.txt"])[0]
            prefix = (qs.get("prefix") or [state])[0].upper() or None
            if len(state) != 2 or not state.isalpha():
                return self._json(400, {"error": "state must be a 2-letter code"})
            try:
                text = body.decode("utf-8", errors="replace")
                res = parse_nbi(text, state, prefix)
            except ValueError as e:
                return self._json(400, {"error": str(e)})
            except Exception as e:  # noqa: BLE001
                return self._json(500, {"error": str(e)[:300]})
            parse_id = _next("parse")
            PARSES[parse_id] = {"rows": res["rows"],
                                "meta": {"state": state, "filename": filename,
                                         "format": res["format"],
                                         "total_records": res["total_records"],
                                         "skipped_coords": res["skipped_coords"]},
                                "ts": time.time()}
            while len(PARSES) > MAX_PARSES:  # evict oldest
                oldest = min(PARSES, key=lambda k: PARSES[k]["ts"])
                del PARSES[oldest]
            sample = [{k: r.get(k) for k in
                       ("asset_id", "struct_no", "county", "district",
                        "facility", "location", "lat", "lon")}
                      for r in res["rows"][:10]]
            return self._json(200, {
                "parse_id": parse_id, "state": state, "filename": filename,
                "format": res["format"], "layout_verified": res["layout_verified"],
                "total_records": res["total_records"], "loadable": res["loadable"],
                "skipped_coords": res["skipped_coords"],
                "districts": res["districts"], "bbox": res["bbox"],
                "sample_rows": sample})

        if path == "/api/nbi/check":
            parse_id = (qs.get("parse_id") or [""])[0]
            parse = PARSES.get(parse_id)
            if not parse:
                return self._json(400, {"error": "parse expired; re-upload"})
            try:
                new_ids = [x["asset_id"] for x in parse["rows"]]
                dupes = len(new_ids) - len(set(new_ids))
                existing = existing_asset_ids()
                collisions = [a for a in new_ids if a in existing]
                return self._json(200, {
                    "collision_count": len(collisions),
                    "collisions": collisions[:50],
                    "within_batch_duplicates": dupes,
                    "existing_count": len(existing)})
            except Exception as e:  # noqa: BLE001
                return self._json(500, {"error": str(e)[:300]})

        if path == "/api/nbi/import":
            parse_id = (qs.get("parse_id") or [""])[0]
            imported_by = (qs.get("imported_by") or [""])[0][:120]
            parse = PARSES.get(parse_id)
            if not parse:
                return self._json(400, {"error": "parse expired; re-upload"})
            job_id = _next("job")
            meta = parse["meta"]
            JOBS[job_id] = {"status": "running", "done": 0,
                            "total": len(parse["rows"]), "loaded": 0,
                            "skipped": meta["skipped_coords"], "error": None}
            t = threading.Thread(target=run_import,
                                 args=(job_id, parse_id, meta["state"],
                                       meta["filename"], imported_by,
                                       meta["format"]),
                                 daemon=True)
            t.start()
            return self._json(200, {"job_id": job_id, "status": "started"})

        return self._json(404, {"error": "not found"})

    def _serve_static(self, path):
        rel = path.lstrip("/") or "index.html"
        # block path traversal
        full = os.path.normpath(os.path.join(DIST_DIR, rel))
        if not full.startswith(os.path.normpath(DIST_DIR)):
            self.send_response(403); self.end_headers(); return
        if os.path.isdir(full):
            full = os.path.join(full, "index.html")
        if not os.path.exists(full):
            full = os.path.join(DIST_DIR, "index.html")  # SPA fallback
        if not os.path.exists(full):
            self.send_response(404); self.end_headers(); return
        ctype, _ = mimetypes.guess_type(full)
        with open(full, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    if not SERVICE_KEY:
        print("WARNING: SUPABASE_SERVICE_ROLE_KEY not set; /api/nbi/* will fail")
    srv = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"serving dist={DIST_DIR} on :{port}", flush=True)
    srv.serve_forever()
