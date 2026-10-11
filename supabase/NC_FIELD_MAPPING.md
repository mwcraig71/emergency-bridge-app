# NC NBI → emg_bridges field mapping

Source: `~/workspace/user/files/NC25.txt` — FHWA NBI extract, 19,343 records,
CSV with header row. Text values wrapped in single quotes, all values
space-padded (strip both when parsing; use `csv.reader(quotechar="'",
skipinitialspace=True)`).

## Coordinate conversion

- `LAT_016`: 8-digit DMS `DDMMSSss` → decimal degrees
- `LONG_017`: 9-digit DMS `DDDMMSSss` → decimal degrees, **negate** (positive-west)
- Geometry stored as `SRID=4326;POINT(lon lat)` EWKT
- 128 records have invalid DMS (minutes/seconds ≥ 60) — skipped, not loaded

## NBI → column mapping

| emg_bridges column | NC25 field | notes |
|---|---|---|
| asset_id | STRUCTURE_NUMBER_008 | strip spaces/quotes, then leading zeros; if empty after strip keep original (e.g. `2NC0328`). **Cross-state collisions**: 171 NC ids collide with SC ids → needs `--prefix` or composite-key decision before load |
| struct_no | STRUCTURE_NUMBER_008 | stripped, as-is |
| state | — | constant `'NC'` |
| county | COUNTY_CODE_003 | 3-digit, 100 NC counties; stripped |
| county_name | — | NULL (needs FIPS lookup — follow-up) |
| district | HIGHWAY_DISTRICT_002 | strip, strip leading zeros → `1`–`14`; `00`/`2`/`52` (183 records) → NULL |
| facility | FACILITY_CARRIED_007 | |
| feature | FEATURES_DESC_006A | |
| location | LOCATION_009 | |
| deck | DECK_COND_058 | |
| super | SUPERSTRUCTURE_COND_059 | |
| sub | SUBSTRUCTURE_COND_060 | |
| channel | CHANNEL_COND_061 | |
| culvert | CULVERT_COND_062 | |
| struct_eval | STRUCTURAL_EVAL_067 | |
| deck_geom | DECK_GEOMETRY_EVAL_068 | |
| scour | SCOUR_CRITICAL_113 | NBI item 113 codes (`8`,`5`,`N`…) — matches SC's scour column format |
| inv_rating | INVENTORY_RATING_066 | |
| op_rating | OPERATING_RATING_064 | |
| posting | POSTING_EVAL_070 | |
| design_load | DESIGN_LOAD_031 | |
| yr_built | YEAR_BUILT_027 | int, `''` → NULL |
| yr_recon | YEAR_RECONSTRUCTED_106 | int, `''` → NULL |
| length_m | STRUCTURE_LEN_MT_049 | numeric |
| max_span_m | MAX_SPAN_LEN_MT_048 | numeric |
| spans | MAIN_UNIT_SPANS_045 | int |
| lanes | TRAFFIC_LANES_ON_028A | int |
| skew | DEGREES_SKEW_034 | int |
| adt | ADT_029 | int |
| truck_pct | PERCENT_ADT_TRUCK_109 | numeric |
| insp_freq | INSPECT_FREQ_MONTHS_091 | int |
| last_inspect | DATE_OF_INSPECT_090 | text as-is |
| maint | MAINTENANCE_021 | |
| owner | OWNER_022 | |
| status | OPEN_CLOSED_POSTED_041 | |
| bridge_cond | BRIDGE_CONDITION | precomputed in file (`G`/`F`/`P`) |
| lowest | LOWEST_RATING | precomputed in file |
| span_mat | STRUCTURE_KIND_043A | |
| span_type | STRUCTURE_TYPE_043B | |
| geom | LAT_016 + LONG_017 | see above |

## Follow-ups

1. **NC division boundaries**: not yet built. Dissolve Census TIGER NC county
   polygons by NCDOT division (1–14), same method as SC's `scdot_districts`,
   then load into `emg_districts` with `state='NC'`.
2. **County names**: join `COUNTY_CODE_003` against a NC county FIPS lookup to
   fill `county_name`.
3. **Asset-ID namespacing decision**: 171 NC/SC collisions — see seed script
   `--prefix` option and the pending decision (prefix vs composite key).
