#!/usr/bin/env python3
"""DriveNC backend sync job (Python version).

Calls the drivenc-* CLIs and upserts results into Supabase emg_drivedata_*
tables using the Secure Vault surrogate via urllib (which handles the
surrogate exchange through the egress proxy).

Replaces sync-drivedata.mjs, which failed because Node's fetch bypasses
the surrogate exchange.
"""
import sys, json, subprocess
from datetime import datetime, timezone

sys.path.insert(0, '/opt/hatch/skills/skill-creator/bin')
from dynamic_credentials import add_surrogate_to_request
import urllib.request

BIN = '/home/hatch/workspace/skills/drivenc/bin'
SUPABASE_URL = 'https://qyymkvjvqofcaeustqqy.supabase.co'
ALLOWED = ['qyymkvjvqofcaeustqqy.supabase.co']

def run_cli(name, args=None):
    result = subprocess.run(
        [f'{BIN}/{name}'] + (args or []),
        capture_output=True, text=True, timeout=90)
    if result.returncode != 0:
        raise RuntimeError(f'{name} failed: {result.stderr[:300]}')
    return json.loads(result.stdout)

def upsert(table, rows):
    if not rows:
        print(f'  {table}: 0 rows, skipping')
        return 0
    # Batch in 500s
    total = 0
    for i in range(0, len(rows), 500):
        batch = rows[i:i+500]
        url = f'{SUPABASE_URL}/rest/v1/{table}?on_conflict=id'
        data = json.dumps(batch).encode()
        req = urllib.request.Request(url, data=data, method='POST', headers={
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates',
        })
        add_surrogate_to_request(
            req, 'custom.supabase-emergency-app',
            allowed_hosts=ALLOWED)
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                pass
        except Exception as e:
            raise RuntimeError(f'{table} upsert failed: {e}')
        total += len(batch)
    print(f'  {table}: upserted {total} rows')
    return total

def to_iso(unix):
    if not unix:
        return None
    return datetime.fromtimestamp(unix, tz=timezone.utc).isoformat()

def main():
    print(f'[sync-drivedata] {datetime.now(timezone.utc).isoformat()}')

    # 1. Events
    events = run_cli('drivenc-events')
    if not isinstance(events, list):
        events = []
    mapped_events = []
    for e in events:
        if not e or e.get('ID') is None:
            continue
        try:
            lon = float(e.get('Longitude'))
            lat = float(e.get('Latitude'))
        except (TypeError, ValueError):
            continue
        if not (lon == lon and lat == lat):  # NaN check
            continue
        detours = e.get('DetourInstructions')
        mapped_events.append({
            'id': str(e['ID']),
            'roadway': e.get('RoadwayName') or '',
            'direction': e.get('DirectionOfTravel') or '',
            'description': e.get('Description') or '',
            'event_type': e.get('EventType') or '',
            'event_subtype': e.get('EventSubType') or '',
            'is_full_closure': e.get('IsFullClosure') is True,
            'severity': e.get('Severity') or '',
            'lanes_affected': e.get('LanesAffected') or '',
            'county': e.get('County') or '',
            'lon': lon,
            'lat': lat,
            'reported': to_iso(e.get('Reported')),
            'last_updated': to_iso(e.get('LastUpdated')) or datetime.now(timezone.utc).isoformat(),
            'detour_instructions': detours if isinstance(detours, list) else [],
            'synced_at': datetime.now(timezone.utc).isoformat(),
        })
    upsert('emg_drivedata_events', mapped_events)

    # 2. Message signs
    signs = run_cli('drivenc-signs')
    if not isinstance(signs, list):
        signs = []
    mapped_signs = []
    for s in signs:
        if not s or s.get('Id') is None:
            continue
        try:
            lon = float(s.get('Longitude'))
            lat = float(s.get('Latitude'))
        except (TypeError, ValueError):
            continue
        if not (lon == lon and lat == lat):
            continue
        msgs = s.get('Messages')
        messages = []
        if isinstance(msgs, list):
            for m in msgs:
                if isinstance(m, str):
                    messages.append(m)
                elif isinstance(m, dict) and m.get('Text'):
                    messages.append(m['Text'])
        mapped_signs.append({
            'id': str(s['Id']),
            'name': s.get('Name') or '',
            'roadway': s.get('Roadway') or '',
            'direction': s.get('DirectionOfTravel') or '',
            'messages': messages,
            'county': s.get('County') or '',
            'lon': lon,
            'lat': lat,
            'last_updated': to_iso(s.get('LastUpdated')) or datetime.now(timezone.utc).isoformat(),
            'synced_at': datetime.now(timezone.utc).isoformat(),
        })
    upsert('emg_drivedata_signs', mapped_signs)

    # 3. Work zones (WZDx GeoJSON)
    wzdx = run_cli('drivenc-wzdx')
    features = wzdx.get('features') if isinstance(wzdx, dict) else []
    if not isinstance(features, list):
        features = []
    feed_updated = (wzdx.get('feed_info') or {}).get('update_date') if isinstance(wzdx, dict) else None
    mapped_wz = []
    for f in features:
        if not f or f.get('id') is None:
            continue
        core = (f.get('properties') or {}).get('core_details') or {}
        road_names = core.get('road_names')
        mapped_wz.append({
            'id': str(f['id']),
            'road_names': road_names if isinstance(road_names, list) else [],
            'direction': core.get('direction') or '',
            'description': core.get('description') or '',
            'geometry': f.get('geometry'),
            'last_updated': feed_updated or datetime.now(timezone.utc).isoformat(),
            'synced_at': datetime.now(timezone.utc).isoformat(),
        })
    upsert('emg_drivedata_workzones', mapped_wz)

    print('[sync-drivedata] done')

if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print(f'[sync-drivedata] FAILED: {e}', file=sys.stderr)
        sys.exit(1)
