#!/usr/bin/env python3
"""Shared NBI parsing for the Emergency Bridge Inspection app.

Single source of truth for turning FHWA NBI source files into emg_bridges
rows. Used by:
  - supabase/seed_bridges.py  (SC GeoJSON path — imports clean()/col sets)
  - supabase/seed_nc.py       (NC CSV path)
  - server/app.py             (self-service uploader: preview + import)

Supported source variants:
  - CSV with NBI header names (e.g. SC25__1.txt, NC25.txt). Values may be
    single-quote wrapped and space-padded; both are stripped.
  - Fixed-width NBI tape layout (standard FHWA item positions). Parsed
    best-effort and ALWAYS flagged layout_verified=False so the uploader UI
    can show an "unverified layout — check sample rows" banner. This layout
    has not yet been validated against a real fixed-width file.

Coordinates are DMS strings (LAT_016 = DDMMSSss, LONG_017 = DDDMMSSss);
longitudes are positive-west and are negated on conversion.
"""
from __future__ import annotations

import csv
import io

# emg_bridges columns (excludes asset_id/state/geom, added by callers)
BRIDGE_COLS = ["struct_no", "county", "county_name", "district", "facility",
    "feature", "location", "deck", "super", "sub", "channel", "culvert",
    "struct_eval", "deck_geom", "scour", "inv_rating", "op_rating", "posting",
    "design_load", "yr_built", "yr_recon", "length_m", "max_span_m", "spans",
    "lanes", "skew", "adt", "truck_pct", "insp_freq", "last_inspect", "maint",
    "owner", "status", "bridge_cond", "lowest", "span_mat", "span_type"]
INT_COLS = {"yr_built", "yr_recon", "spans", "lanes", "skew", "adt", "insp_freq"}
NUM_COLS = {"length_m", "max_span_m", "truck_pct"}

# NBI CSV header name -> emg_bridges column. SC25 and NC25 share these names.
FIELD_MAP = {
    "STRUCTURE_NUMBER_008": "struct_no",
    "HIGHWAY_DISTRICT_002": "district",
    "COUNTY_CODE_003": "county",
    "FACILITY_CARRIED_007": "facility",
    "FEATURES_DESC_006A": "feature",
    "LOCATION_009": "location",
    "DECK_COND_058": "deck",
    "SUPERSTRUCTURE_COND_059": "super",
    "SUBSTRUCTURE_COND_060": "sub",
    "CHANNEL_COND_061": "channel",
    "CULVERT_COND_062": "culvert",
    "STRUCTURAL_EVAL_067": "struct_eval",
    "DECK_GEOMETRY_EVAL_068": "deck_geom",
    "SCOUR_CRITICAL_113": "scour",
    "INVENTORY_RATING_066": "inv_rating",
    "OPERATING_RATING_064": "op_rating",
    "POSTING_EVAL_070": "posting",
    "DESIGN_LOAD_031": "design_load",
    "YEAR_BUILT_027": "yr_built",
    "YEAR_RECONSTRUCTED_106": "yr_recon",
    "STRUCTURE_LEN_MT_049": "length_m",
    "MAX_SPAN_LEN_MT_048": "max_span_m",
    "MAIN_UNIT_SPANS_045": "spans",
    "TRAFFIC_LANES_ON_028A": "lanes",
    "DEGREES_SKEW_034": "skew",
    "ADT_029": "adt",
    "PERCENT_ADT_TRUCK_109": "truck_pct",
    "INSPECT_FREQ_MONTHS_091": "insp_freq",
    "DATE_OF_INSPECT_090": "last_inspect",
    "MAINTENANCE_021": "maint",
    "OWNER_022": "owner",
    "OPEN_CLOSED_POSTED_041": "status",
    "STRUCTURE_KIND_043A": "span_mat",
    "STRUCTURE_TYPE_043B": "span_type",
}
# Optional precomputed columns some extracts carry; else computed from ratings.
PRECOMPUTED = {"BRIDGE_CONDITION": "bridge_cond", "LOWEST_RATING": "lowest"}

# Fixed-width NBI tape layout: (start, end) 1-indexed inclusive -> column.
# Standard FHWA item positions. Identity + coordinates are high-confidence;
# descriptive fields are best-effort until validated against a real file.
FIXED_WIDTH_FIELDS = [
    ((1, 3), None),            # state code (validated, not stored)
    ((4, 18), "struct_no"),
    ((20, 21), "district"),
    ((22, 24), "county"),
    ((25, 48), "feature"),
    ((49, 72), "facility"),
    ((73, 96), "location"),
    ((97, 104), "__lat__"),
    ((105, 113), "__lon__"),
    ((114, 115), "maint"),
    ((116, 117), "owner"),
    ((118, 121), "yr_built"),
    ((122, 123), "lanes"),
    ((124, 129), "adt"),
    ((130, 130), "design_load"),
    ((131, 132), "skew"),
    ((133, 133), "span_mat"),
    ((134, 136), "span_type"),
    ((137, 139), "spans"),
    ((140, 144), "max_span_m"),
    ((145, 149), "length_m"),
    ((150, 150), "deck"),
    ((151, 151), "super"),
    ((152, 152), "sub"),
    ((153, 153), "channel"),
    ((154, 154), "culvert"),
    ((155, 157), "op_rating"),
    ((158, 160), "inv_rating"),
    ((161, 161), "struct_eval"),
    ((162, 162), "deck_geom"),
    ((163, 163), "posting"),
    ((166, 169), "last_inspect"),
    ((170, 171), "insp_freq"),
    ((172, 175), "yr_recon"),
    ((176, 176), "scour"),
]


def clean(col, v):
    """Normalize one raw value for column `col`. Quotes/spaces stripped,
    '' -> None, ints/floats coerced (unparseable -> None)."""
    if v is None:
        return None
    if isinstance(v, str):
        v = v.strip().strip("'").strip()
    if v == "" or v is None:
        return None
    if col in INT_COLS:
        try:
            return int(str(v).strip())
        except (ValueError, TypeError):
            return None
    if col in NUM_COLS:
        try:
            return float(str(v).strip())
        except (ValueError, TypeError):
            return None
    return v if isinstance(v, str) else str(v)


def dms_to_dd(dms, ndig):
    """DDMMSSss / DDDMMSSss -> decimal degrees. None if malformed."""
    if dms is None:
        return None
    s = str(dms).strip().strip("'").strip()
    if len(s) != ndig or not s.isdigit():
        return None
    deg_len = ndig - 6
    deg = int(s[:deg_len])
    minutes = int(s[deg_len:deg_len + 2])
    seconds = int(s[deg_len + 2:deg_len + 4]) + int(s[deg_len + 4:]) / 100.0
    if minutes >= 60 or seconds >= 60.0:
        return None
    return deg + minutes / 60.0 + seconds / 3600.0


def make_asset_id(struct_no, prefix=None):
    """Zero-strip the structure number; prefix with state when given.
    Non-numeric IDs (e.g. '2NC0328') survive unchanged."""
    s = str(struct_no or "").strip().strip("'").strip()
    z = s.lstrip("0")
    base = z if z else s
    return f"{prefix}-{base}" if prefix else base


# Normalized district codes known to be junk, by state. Applied AFTER
# zero-stripping (so '00' is already None via clean_district).
STATE_JUNK_DISTRICTS = {
    "NC": {"52"},  # not a real NCDOT division (valid: 1-14)
}


def clean_district(v, state=None):
    """Normalize a district/division code; junk -> None."""
    if v is None:
        return None
    s = str(v).strip().strip("'").strip().lstrip("0")
    if s == "" or not s.isdigit():
        return None
    junk = STATE_JUNK_DISTRICTS.get((state or "").upper(), set())
    if s in junk:
        return None
    return s


# Rough per-state bounding boxes (lon/lat degrees) used to reject
# implausible coordinates — NBI files contain genuine digit errors
# (e.g. transposed longitude digits). Rows outside their state's box
# are counted as skipped_coords, never loaded.
# Format: "ST": (min_lon, min_lat, max_lon, max_lat)
STATE_BBOX = {
    "AL": (-88.6, 30.1, -84.8, 35.1), "AK": (-180.0, 51.0, -129.0, 72.0),
    "AZ": (-114.9, 31.3, -109.0, 37.1), "AR": (-94.7, 32.9, -89.5, 36.6),
    "CA": (-124.5, 32.4, -114.0, 42.1), "CO": (-109.1, 36.9, -102.0, 41.1),
    "CT": (-73.8, 40.9, -71.8, 42.1), "DE": (-75.8, 38.4, -75.0, 39.9),
    "DC": (-77.2, 38.8, -76.9, 39.0), "FL": (-87.7, 24.4, -79.9, 31.1),
    "GA": (-85.7, 30.2, -80.8, 35.1), "HI": (-160.3, 18.8, -154.8, 22.3),
    "ID": (-117.3, 41.9, -111.0, 49.1), "IL": (-91.6, 36.9, -87.4, 42.6),
    "IN": (-88.1, 37.7, -84.7, 41.8), "IA": (-96.5, 40.3, -90.0, 43.6),
    "KS": (-102.1, 36.9, -94.5, 40.1), "KY": (-89.7, 36.4, -81.9, 39.2),
    "LA": (-94.1, 28.8, -89.5, 33.1), "ME": (-71.2, 43.0, -66.9, 47.5),
    "MD": (-79.6, 37.9, -75.0, 39.8), "MA": (-73.5, 41.1, -69.8, 42.9),
    "MI": (-90.5, 41.6, -82.3, 48.4), "MN": (-97.3, 43.4, -89.0, 49.4),
    "MS": (-91.7, 30.0, -88.0, 35.1), "MO": (-95.8, 35.9, -89.0, 40.7),
    "MT": (-116.1, 44.3, -104.0, 49.1), "NE": (-104.1, 39.9, -95.2, 43.1),
    "NV": (-120.1, 34.9, -113.9, 42.1), "NH": (-72.6, 42.6, -70.6, 45.4),
    "NJ": (-75.6, 38.8, -73.8, 41.4), "NM": (-109.1, 31.7, -102.9, 37.1),
    "NY": (-79.9, 40.4, -71.7, 45.1), "NC": (-84.5, 33.7, -75.3, 36.7),
    "ND": (-104.1, 45.8, -96.8, 49.1), "OH": (-84.9, 38.3, -80.4, 42.0),
    "OK": (-103.1, 33.5, -94.3, 37.1), "OR": (-124.6, 41.9, -116.4, 46.3),
    "PA": (-80.6, 39.6, -74.6, 42.3), "RI": (-71.9, 41.1, -71.1, 42.1),
    "SC": (-83.4, 32.0, -78.4, 35.3), "SD": (-104.1, 42.4, -96.4, 45.9),
    "TN": (-90.4, 34.9, -81.5, 36.7), "TX": (-106.5, 25.7, -93.4, 36.6),
    "UT": (-114.1, 36.9, -109.0, 41.1), "VT": (-73.5, 42.6, -71.4, 45.1),
    "VA": (-83.7, 36.4, -75.1, 39.5), "WA": (-124.8, 45.5, -116.8, 49.1),
    "WV": (-82.7, 37.1, -77.6, 39.8), "WI": (-92.9, 42.3, -86.7, 47.1),
    "WY": (-111.1, 40.9, -104.0, 45.1), "PR": (-67.3, 17.8, -65.5, 18.6),
}


def in_state_bbox(lat, lon, state):
    """Plausibility check: is (lat, lon) inside the state's rough bbox?
    Unknown states pass (no box defined)."""
    box = STATE_BBOX.get((state or "").upper())
    if not box:
        return True
    minlon, minlat, maxlon, maxlat = box
    return minlon <= lon <= maxlon and minlat <= lat <= maxlat
def compute_lowest(row):
    """Lowest numeric condition rating across deck/super/sub/channel/culvert."""
    best = None
    for k in ("deck", "super", "sub", "channel", "culvert"):
        v = row.get(k)
        if isinstance(v, str) and len(v) == 1 and v.isdigit():
            d = int(v)
            best = d if best is None else min(best, d)
    return str(best) if best is not None else None


def detect_format(text):
    """'csv' | 'fixedwidth' | 'unknown'.

    CSV: first non-blank line contains commas AND a known NBI header token.
    Fixed-width: long lines (>=200 chars), no commas, plausible DMS latitude
    at the standard position (chars 97-104).
    """
    lines = [ln for ln in text.splitlines() if ln.strip()]
    if not lines:
        return "unknown"
    first = lines[0]
    upper = first.upper()
    if "," in first and ("STRUCTURE_NUMBER_008" in upper or "LAT_016" in upper):
        return "csv"
    sample = [ln for ln in lines[:50] if len(ln) >= 176 and "," not in ln]
    if len(sample) >= 10:
        ok = 0
        for ln in sample[:20]:
            if dms_to_dd(ln[96:104], 8) is not None:
                ok += 1
        if ok >= 10:
            return "fixedwidth"
    return "unknown"


def _finalize(row, state, prefix, lat, lon):
    row["asset_id"] = make_asset_id(row.get("struct_no", ""), prefix)
    row["state"] = state
    row["district"] = clean_district(row.get("district"), state)
    row["county_name"] = None
    if row.get("bridge_cond") is None or row.get("lowest") is None:
        low = compute_lowest(row)
        if row.get("lowest") is None:
            row["lowest"] = low
        if row.get("bridge_cond") is None:
            row["bridge_cond"] = low
    row["lat"] = lat
    row["lon"] = lon
    row["geom_ewkt"] = f"SRID=4326;POINT({lon} {lat})"
    return row


def parse_csv(text, state, prefix=None):
    """Parse NBI CSV text. Returns dict with rows/stats (see parse_nbi)."""
    rows, skipped = [], 0
    rdr = csv.reader(io.StringIO(text), quotechar="'", skipinitialspace=True)
    try:
        header = next(rdr)
    except StopIteration:
        return _result("csv", True, rows, 0, 0)
    header = [h.strip().strip("'").strip().upper() for h in header]
    idx = {name: i for i, name in enumerate(header)}
    total = 0
    for r in rdr:
        total += 1
        if len(r) != len(header):
            skipped += 1
            continue
        get = lambda n: r[idx[n]].strip() if n in idx else ""  # noqa: E731
        lat = dms_to_dd(get("LAT_016"), 8)
        lon = dms_to_dd(get("LONG_017"), 9)
        if lat is None or lon is None:
            skipped += 1
            continue
        lon = -lon  # positive-west
        if not in_state_bbox(lat, lon, state):
            skipped += 1
            continue
        row = {}
        for src, dst in FIELD_MAP.items():
            row[dst] = clean(dst, get(src))
        for src, dst in PRECOMPUTED.items():
            if src in idx:
                row[dst] = clean(dst, get(src))
        rows.append(_finalize(row, state, prefix, lat, lon))
    return _result("csv", True, rows, total, skipped)


def parse_fixedwidth(text, state, prefix=None):
    """Parse fixed-width NBI tape. layout_verified=False (unvalidated)."""
    rows, skipped, bad = [], 0, 0
    lines = [ln for ln in text.splitlines() if ln.strip()]
    total = len(lines)
    for ln in lines:
        if len(ln) < 176:
            skipped += 1
            continue
        lat = dms_to_dd(ln[96:104], 8)
        lon = dms_to_dd(ln[104:113], 9)
        if lat is None or lon is None:
            skipped += 1
            continue
        lon = -lon
        if not in_state_bbox(lat, lon, state):
            skipped += 1
            continue
        row = {}
        for (a, b), col in FIXED_WIDTH_FIELDS:
            if col is None or col.startswith("__"):
                continue
            row[col] = clean(col, ln[a - 1:b])
        rows.append(_finalize(row, state, prefix, lat, lon))
    return _result("fixedwidth", False, rows, total, skipped)


def _result(fmt, verified, rows, total, skipped):
    lons = [r["lon"] for r in rows]
    lats = [r["lat"] for r in rows]
    districts = sorted({r["district"] for r in rows if r["district"]},
                       key=lambda d: (len(d), d))
    return {
        "format": fmt,
        "layout_verified": verified,
        "total_records": total,
        "loadable": len(rows),
        "skipped_coords": skipped,
        "districts": districts,
        "bbox": [min(lons), min(lats), max(lons), max(lats)] if rows else None,
        "rows": rows,
    }


def parse_nbi(text, state, prefix=None):
    """Auto-detect and parse. Raises ValueError on unknown format."""
    fmt = detect_format(text)
    if fmt == "csv":
        return parse_csv(text, state, prefix)
    if fmt == "fixedwidth":
        return parse_fixedwidth(text, state, prefix)
    raise ValueError("Unknown NBI format: expected CSV with NBI headers "
                     "or fixed-width NBI tape.")
