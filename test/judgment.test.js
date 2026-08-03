// Judgment harness (spec §12.1): golden scenarios in → expected prediction +
// checklist out. Every scenario runs TWICE and must produce byte-identical
// output both times — the deterministic-core guarantee, enforced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { predict, buildChecklist, packetFromChecklist } from '../src/core/decide.js';
import { verdict } from '../src/domain/verdict-sim.js';

const golden = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'golden', 'judgment-scenarios.json'), 'utf8'));

function deepFreeze(o) {
  if (o && typeof o === 'object') { Object.freeze(o); Object.values(o).forEach(deepFreeze); }
  return o;
}

function runOnce(s) {
  const input = deepFreeze(JSON.parse(JSON.stringify({
    payerId: s.payer_id, facts: s.facts, requirements: s.requirements,
  })));
  const p = predict(input);
  const checklist = buildChecklist(input);
  const packet = packetFromChecklist(input.facts, checklist);
  return { p, checklist, packet };
}

for (const s of golden.scenarios) {
  test(`judgment: ${s.name}`, () => {
    const run1 = runOnce(s);
    const run2 = runOnce(s);

    // (b) run-to-run identity — same inputs, same outputs, always.
    assert.deepEqual(run1, run2, 'run-to-run outputs must be identical');

    // (a) match vs expected
    const e = s.expect;
    assert.equal(run1.p.prediction, e.prediction, 'prediction');
    if (e.confidence !== undefined) assert.equal(run1.p.confidence, e.confidence, 'confidence');
    if (e.missing_codes) {
      assert.deepEqual(run1.p.missing.map((m) => m.code).sort(), [...e.missing_codes].sort(), 'missing codes');
    }
    if (e.checklist_included_keys) {
      assert.deepEqual(
        run1.checklist.filter((i) => i.included).map((i) => i.key).sort(),
        [...e.checklist_included_keys].sort(), 'checklist included keys');
    }
    if (e.packet) assert.deepEqual(run1.packet, e.packet, 'assembled packet');

    // Cross-check against ground truth: when the core commits to a verdict,
    // the real simulator must agree with the assembled packet.
    if (s.cross_check_ground_truth) {
      const gt = verdict(run1.packet, s.payer_id);
      if (run1.p.prediction === 'LIKELY_APPROVED') assert.equal(gt.outcome, 'APPROVED', 'ground truth agrees: approved');
      if (run1.p.prediction === 'LIKELY_DENIED') assert.equal(gt.outcome, 'DENIED', 'ground truth agrees: denied');
      if (run1.p.prediction === 'LIKELY_EXPEDITED') assert.equal(gt.outcome, 'EXPEDITED', 'ground truth agrees: expedited');
    }
  });
}

test('judgment: what-if is pure (wait-2-weeks flips bluepeak 4wk case)', async () => {
  const s = golden.scenarios.find((x) => x.name === 'bluepeak-4wk-after-first-denial');
  const { whatIf } = await import('../src/core/decide.js');
  const base = { payerId: s.payer_id, facts: s.facts, requirements: s.requirements };
  const flipped = whatIf({ ...base, delta: { therapy_weeks: 6 } });
  assert.equal(flipped.prediction, 'LIKELY_APPROVED');
  // original untouched
  assert.equal(predict(base).prediction, 'LIKELY_DENIED');
});
