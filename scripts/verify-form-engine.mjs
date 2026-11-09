#!/usr/bin/env node
// Phase 2 verification: walk the default template through every branch
// of design Appendix A's branch map using the REAL form engine
// (app/src/lib/formEngine.ts) + compiled-in default template
// (app/src/lib/defaultTemplate.ts), and compare the derived outcome +
// core column values against what the legacy TriageFlow produces for
// the same answers (legacy behavior encoded below from TriageFlow's
// finish() validation and its button-driven outcomes).
//
// Run: node scripts/verify-form-engine.mjs   (exit 0 = all checks pass)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(join(tmpdir(), 'form-engine-verify-'));
const entry = join(work, 'entry.ts');
writeFileSync(
  entry,
  [
    `export * from ${JSON.stringify(join(repoRoot, 'app/src/lib/formEngine.ts'))};`,
    `export * from ${JSON.stringify(join(repoRoot, 'app/src/lib/defaultTemplate.ts'))};`,
  ].join('\n'),
);
const bundle = join(work, 'bundle.mjs');
execFileSync(
  join(repoRoot, 'app/node_modules/.bin/esbuild'),
  [entry, '--bundle', '--platform=node', '--format=esm', `--outfile=${bundle}`],
  { stdio: 'inherit' },
);
const E = await import(pathToFileURL(bundle).href);
const Q = E.BUILTIN_QUESTIONS;
const byField = (f) => Q.find((q) => q.maps_to_system_field === f);
const bySort = (n) => Q.find((q) => q.sort_order === n);

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// --- Draft simulation, mirroring FormFlow's state updates exactly ---
function freshCore() {
  return {
    destroyed: null, access: null, drone_used: null, bridge_still_there: null,
    overtopped: null, overtop_depth_ft: null, overtop_depth_unknown: false,
    damage_rail: 'no', damage_deck: 'no', damage_super: 'no', damage_sub: 'no',
    washout_abutment: 'no', remain_open: null, remain_open_notes: '',
    safe_load: null, safe_load_notes: '', debris_amount: null,
    photos: [], form_answers: [],
  };
}
function answer(draft, q, value) {
  let next = { ...draft, form_answers: E.withAnswer(draft.form_answers, q, value) };
  next = E.applyWriteThrough(next, q, value);
  return next;
}
function addPhoto(draft, q, id) {
  const photos = [...draft.photos, { id, photo_type: E.photoTypeFor(q), taken_at: '2026-11-09T00:00:00Z' }];
  return { ...draft, photos, form_answers: E.syncPhotoAnswers(draft.form_answers, Q, photos) };
}
function finish(draft) {
  const missing = E.missingRequired(Q, draft.form_answers, draft.photos)
    .map((q) => q.prompt);
  const normalized = E.normalizeCore(draft);
  return { missing, outcome: E.deriveOutcome(normalized), core: normalized };
}

// --- Legacy reference (TriageFlow): outcomes are button-driven ---
function legacyOutcome(a) {
  if (a.destroyed === 'yes') return 'destroyed';
  if (a.access === 'no' && a.drone_used === 'yes' && a.bridge_still_there === 'no') return 'likely_destroyed';
  if (a.access === 'no' && a.drone_used === 'yes' && a.bridge_still_there === 'yes') return 'ground_followup';
  if (a.access === 'no') return 'revisit';
  return 'complete';
}

// 0. Template sanity: 27 questions, 18 core, every Appendix C field claimed once.
check('template has 27 questions', Q.length === 27, `got ${Q.length}`);
check('template has 18 core questions', Q.filter((q) => q.is_core).length === 18);
const fields = ['destroyed','access','drone_used','bridge_still_there','overtopped','overtop_depth_ft','damage_rail','damage_deck','damage_super','damage_sub','washout_abutment','remain_open','remain_open_notes','safe_load','safe_load_notes','debris_amount'];
check('every system field claimed exactly once',
  fields.every((f) => Q.filter((q) => q.maps_to_system_field === f).length === 1));

// 1. Triage chain: engine outcome == legacy outcome for every combination.
let combos = 0;
for (const destroyed of ['yes', 'no']) {
  for (const access of ['yes', 'no']) {
    for (const drone of ['yes', 'no']) {
      for (const still of ['yes', 'no']) {
        let d = freshCore();
        d = answer(d, byField('destroyed'), { value: destroyed });
        if (destroyed === 'no') {
          d = answer(d, byField('access'), { value: access });
          if (access === 'no') {
            d = answer(d, byField('drone_used'), { value: drone });
            if (drone === 'yes') d = answer(d, byField('bridge_still_there'), { value: still });
          }
        }
        const got = E.deriveOutcome(d);
        const want = legacyOutcome({ destroyed, access, drone_used: drone, bridge_still_there: still });
        combos += 1;
        if (got !== want) check(`outcome destroyed=${destroyed} access=${access} drone=${drone} still=${still}`, false, `engine=${got} legacy=${want}`);
      }
    }
  }
}
check(`outcome engine matches legacy on all ${combos} triage combinations`, failures === 0);

// 2. Destroyed branch: photos required (legacy finish('destroyed') checks both slots).
{
  let d = freshCore();
  d = answer(d, byField('destroyed'), { value: 'yes' });
  let r = finish(d);
  check('destroyed without photos: blocked, profile+approach missing',
    r.missing.includes('Bridge profile photo') && r.missing.length === 2,
    JSON.stringify(r.missing));
  d = addPhoto(d, bySort(2), 'p1');
  r = finish(d);
  check('destroyed with only profile photo: still blocked', r.missing.length === 1);
  d = addPhoto(d, bySort(3), 'p2');
  r = finish(d);
  check('destroyed with both photos: finishable, outcome destroyed',
    r.missing.length === 0 && r.outcome === 'destroyed' && r.core.destroyed === 'yes');
  const photoAns = r.core.form_answers.find((a) => a.question_id === bySort(2).id);
  check('destroyed photo answer links photo ids',
    photoAns && JSON.stringify(photoAns.answer) === JSON.stringify({ photo_ids: ['p1'] }));
}

// 3. Revisit branch: access=no, drone=no.
{
  let d = freshCore();
  d = answer(d, byField('destroyed'), { value: 'no' });
  d = answer(d, byField('access'), { value: 'no' });
  let r = finish(d);
  check('access=no before drone answered: blocked on drone question',
    r.missing.includes('Was drone reconnaissance used?'));
  d = answer(d, byField('drone_used'), { value: 'no' });
  r = finish(d);
  check('revisit: finishable, outcome revisit, core matches legacy',
    r.missing.length === 0 && r.outcome === 'revisit' &&
    r.core.access === 'no' && r.core.drone_used === 'no' && r.core.bridge_still_there === null);
}

// 4. Drone branches.
{
  let base = freshCore();
  base = answer(base, byField('destroyed'), { value: 'no' });
  base = answer(base, byField('access'), { value: 'no' });
  base = answer(base, byField('drone_used'), { value: 'yes' });
  let r = finish(base);
  check('drone=yes before still-there answered: blocked',
    r.missing.includes('Is the bridge still there? (drone observation)'));
  const dNo = answer(base, byField('bridge_still_there'), { value: 'no' });
  r = finish(dNo);
  check('still-there=no: outcome likely_destroyed',
    r.missing.length === 0 && r.outcome === 'likely_destroyed' && r.core.bridge_still_there === 'no');
  const dYes = answer(base, byField('bridge_still_there'), { value: 'yes' });
  r = finish(dYes);
  check('still-there=yes: outcome ground_followup',
    r.missing.length === 0 && r.outcome === 'ground_followup');
}

// 5. Complete path: full answers incl. depth value, damage, decisions.
{
  let d = freshCore();
  d = answer(d, byField('destroyed'), { value: 'no' });
  d = answer(d, byField('access'), { value: 'yes' });
  d = answer(d, byField('overtopped'), { value: 'yes' });
  let r = finish(d);
  check('overtopped=yes without depth: blocked on depth (legacy parity)',
    r.missing.includes('Maximum depth of overtopping (ft)'));
  d = answer(d, byField('overtop_depth_ft'), { value: 3.5 });
  d = answer(d, byField('damage_rail'), { value: 'yes' });
  d = addPhoto(d, bySort(17), 'rail1');
  d = answer(d, byField('remain_open'), { value: 'restricted_lanes' });
  d = answer(d, byField('remain_open_notes'), { value: 'One lane flagged' });
  d = answer(d, byField('safe_load'), { value: 'reduced_load' });
  d = answer(d, byField('debris_amount'), { value: 'one_truck' });
  r = finish(d);
  check('complete path: finishable, outcome complete', r.missing.length === 0 && r.outcome === 'complete', JSON.stringify(r.missing));
  check('complete path: core columns match legacy values',
    r.core.overtopped === 'yes' && r.core.overtop_depth_ft === 3.5 &&
    r.core.overtop_depth_unknown === false &&
    r.core.damage_rail === 'yes' && r.core.damage_deck === 'no' &&
    r.core.remain_open === 'restricted_lanes' &&
    r.core.remain_open_notes === 'One lane flagged' &&
    r.core.safe_load === 'reduced_load' && r.core.debris_amount === 'one_truck');
  const railPhoto = r.core.form_answers.find((a) => a.question_id === bySort(17).id);
  check('damage photo answer recorded under its question',
    railPhoto && railPhoto.answer.photo_ids?.includes('rail1'));
}

// 6. Depth unknown toggle (legacy: overtop_depth_unknown satisfies validation, depth stays null).
{
  let d = freshCore();
  d = answer(d, byField('destroyed'), { value: 'no' });
  d = answer(d, byField('access'), { value: 'yes' });
  d = answer(d, byField('overtopped'), { value: 'yes' });
  d = answer(d, byField('overtop_depth_ft'), { value: null, unknown: true });
  d = answer(d, byField('remain_open'), { value: 'yes' });
  d = answer(d, byField('safe_load'), { value: 'yes' });
  d = answer(d, byField('debris_amount'), { value: 'none' });
  const r = finish(d);
  check('depth unknown: finishable, depth null + unknown flag set',
    r.missing.length === 0 && r.outcome === 'complete' &&
    r.core.overtop_depth_ft === null && r.core.overtop_depth_unknown === true);
}

// 7. Overtopped=no clears depth (legacy parity cleanup) and hides depth question.
{
  let d = freshCore();
  d = answer(d, byField('destroyed'), { value: 'no' });
  d = answer(d, byField('access'), { value: 'yes' });
  d = answer(d, byField('overtopped'), { value: 'yes' });
  d = answer(d, byField('overtop_depth_ft'), { value: 2.0 });
  d = answer(d, byField('overtopped'), { value: 'no' });
  const vis = E.visibleQuestions(Q, d.form_answers);
  check('overtopped=no: depth question not visible',
    !vis.some((q) => q.maps_to_system_field === 'overtop_depth_ft'));
  d = answer(d, byField('remain_open'), { value: 'no' });
  d = answer(d, byField('safe_load'), { value: 'no' });
  d = answer(d, byField('debris_amount'), { value: 'none' });
  const r = finish(d);
  check('overtopped flipped to no: depth normalized to null at finish',
    r.outcome === 'complete' && r.core.overtop_depth_ft === null && r.core.overtop_depth_unknown === false);
}

// 8. Visibility gates.
{
  const vis0 = E.visibleQuestions(Q, []);
  check('nothing answered: only the destroyed root is visible',
    vis0.length === 1 && vis0[0].maps_to_system_field === 'destroyed');
  let d = freshCore();
  d = answer(d, byField('destroyed'), { value: 'no' });
  const vis = E.visibleQuestions(Q, d.form_answers);
  check('destroyed=no: access visible, drone/decisions not yet',
    vis.some((q) => q.maps_to_system_field === 'access') &&
    !vis.some((q) => q.maps_to_system_field === 'drone_used') &&
    !vis.some((q) => q.maps_to_system_field === 'remain_open'));
}

// 9. Legacy complete-path validation parity: missing decisions block finish.
{
  let d = freshCore();
  d = answer(d, byField('destroyed'), { value: 'no' });
  d = answer(d, byField('access'), { value: 'yes' });
  d = answer(d, byField('overtopped'), { value: 'no' });
  const r = finish(d);
  check('complete path missing remain_open/safe_load/debris: all three reported',
    r.missing.includes('Can the bridge remain open?') &&
    r.missing.includes('Is it safe to carry load?') &&
    r.missing.includes('Debris at bridge') && r.missing.length === 3,
    JSON.stringify(r.missing));
}

// 10. Progress counts visible required only.
{
  let d = freshCore();
  d = answer(d, byField('destroyed'), { value: 'yes' });
  const p = E.formProgress(Q, d.form_answers, d.photos);
  check('progress on destroyed branch: 1 of 3 required answered',
    p.answered === 1 && p.total === 3, JSON.stringify(p));
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
