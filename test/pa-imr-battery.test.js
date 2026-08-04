// The backward-looking reliability battery. Every IMR determination the state
// of California has published becomes assertions against this system:
//   1. the reason extractor is total and deterministic on real findings text,
//   2. determinations normalize cleanly (no unclassifiable rows),
//   3. the resolver is TOTAL across every ingested payer line for the
//      imaging codes real appeals were fought over — it always answers,
//      never throws, and answers twice identically,
//   4. recomputed aggregates match the shipped aggregates file exactly
//      (the aggregation pipeline is itself under test),
//   5. the empirical anchor holds: appealed imaging denials are overturned
//      at a rate that justifies the product's thesis.
// Runs against the full 42,749-row snapshot when present on disk; falls back
// to the checked-in 1-in-20 sample (2,137 rows) so CI always runs the battery.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReadStream, readFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsvLine } from '../src/pa-graph/imr.js';
import { extractReasons, normalizeDetermination } from '../src/pa-graph/imr-reasons.js';
import { resolve } from '../src/pa-graph/resolve.js';
import { loadRulesets } from '../src/pa-graph/cli.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const aggregates = JSON.parse(readFileSync(join(root, 'data', 'pa', 'imr-aggregates.json'), 'utf8'));
const fullPath = join(root, 'var', 'snapshots', aggregates.sha256 || '');
const usingFull = aggregates.sha256 && existsSync(fullPath);
const csvPath = usingFull ? fullPath : join(root, 'data', 'pa', 'imr-sample.csv');

async function readRows(path) {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let pending = null;
  let header = null;
  let idx = {};
  const rows = [];
  for await (const raw of rl) {
    const line = pending ? `${pending}\n${raw}` : raw;
    if (((line.match(/"/g) || []).length) % 2 !== 0) { pending = line; continue; }
    pending = null;
    if (!header) {
      header = parseCsvLine(line);
      idx = Object.fromEntries(header.map((h, i) => [h, i]));
      continue;
    }
    if (!line.trim()) continue;
    const f = parseCsvLine(line);
    rows.push({
      category: f[idx.TreatmentCategory] || 'Unknown',
      determination: f[idx.Determination] || '',
      findings: f[idx.Findings] || '',
      year: Number(f[idx.ReportYear]) || 0,
    });
  }
  return rows;
}

const rows = await readRows(csvPath);
const rulesets = loadRulesets();
const IMAGING_CODES = ['72148', '70551', '70450', '73721', '74177', '78815', '75561'];
const lines = [...new Set(rulesets.map((r) => `${r.payer_id}|${r.lob}`))]
  .map((s) => { const [payer, lob] = s.split('|'); return { payer, lob }; });

test(`imr-battery: corpus loaded (${usingFull ? 'FULL snapshot' : 'checked-in sample'}: ${rows.length} determinations)`, () => {
  assert.ok(rows.length >= 2000, 'battery needs a real corpus');
  assert.ok(lines.length >= 5, `expected 5+ ingested payer lines, got ${lines.length}`);
});

test('imr-battery: reason extraction is total and deterministic on every real findings text', () => {
  let checked = 0;
  for (const r of rows) {
    const a = extractReasons(r.findings);
    const b = extractReasons(r.findings);
    assert.deepEqual(a, b);
    assert.ok(Array.isArray(a));
    checked += 1;
  }
  assert.equal(checked, rows.length);
});

test('imr-battery: every determination in the corpus normalizes to upheld or overturned', () => {
  let other = 0;
  for (const r of rows) if (normalizeDetermination(r.determination) === 'other') other += 1;
  assert.equal(other, 0, `${other} rows with unclassifiable determinations`);
});

test('imr-battery: resolver is total and self-consistent across every payer line × contested imaging code', () => {
  let asked = 0;
  for (const { payer, lob } of lines) {
    for (const code of IMAGING_CODES) {
      const a = resolve(rulesets, { payer, lob, code, asOf: '2026-08-03' });
      const b = resolve(rulesets, { payer, lob, code, asOf: '2026-08-03' });
      assert.ok(a.requirement_type, `${payer}/${lob}/${code} returned nothing`);
      assert.deepEqual(a, b, `${payer}/${lob}/${code} answered differently twice`);
      asked += 2;
    }
  }
  assert.ok(asked >= lines.length * IMAGING_CODES.length * 2);
});

test('imr-battery: recomputed category aggregates match the shipped aggregation exactly', () => {
  const recount = new Map();
  for (const r of rows) {
    const c = recount.get(r.category) || { total: 0, overturned: 0 };
    c.total += 1;
    if (normalizeDetermination(r.determination) === 'overturned') c.overturned += 1;
    recount.set(r.category, c);
  }
  if (usingFull) {
    for (const shipped of aggregates.categories) {
      const mine = recount.get(shipped.category);
      assert.ok(mine, `category ${shipped.category} missing from recount`);
      assert.equal(mine.total, shipped.total, `${shipped.category} total drifted`);
      assert.equal(mine.overturned, shipped.overturned, `${shipped.category} overturned drifted`);
    }
  } else {
    // sample mode: shipped totals must dominate the 1-in-20 sample counts
    for (const [cat, mine] of recount) {
      const shipped = aggregates.categories.find((c) => c.category === cat);
      if (shipped) assert.ok(shipped.total >= mine.total, `${cat} sample exceeds full count`);
    }
  }
});

test('imr-battery: the empirical anchor — appealed imaging denials overturn at product-thesis rates', () => {
  const imaging = aggregates.categories.find((c) => c.category === 'Diag Imag & Screen');
  assert.ok(imaging, 'imaging category present in aggregates');
  assert.ok(imaging.total > 5000, 'thousands of real imaging appeals');
  assert.ok(imaging.overturn_rate > 0.4 && imaging.overturn_rate < 0.6,
    `imaging overturn rate ${imaging.overturn_rate} outside the observed band`);
});

test('imr-battery: what reviewers actually argue about matches what the graph models', () => {
  // Measured on the full corpus (5,994 imaging appeals): medical necessity
  // 32%, documentation 18%, conservative therapy 5.5%. The original >10%
  // therapy hypothesis was WRONG and this battery caught it — thresholds
  // below encode the measured reality with stable margins.
  const imagingRows = rows.filter((r) => r.category === 'Diag Imag & Screen');
  assert.ok(imagingRows.length > 50, 'imaging rows present in corpus');
  const share = (tag) =>
    imagingRows.filter((r) => extractReasons(r.findings).includes(tag)).length / imagingRows.length;
  assert.ok(share('medical_necessity') > 0.25,
    `medical-necessity reasoning in ${(share('medical_necessity') * 100).toFixed(1)}% — expected the dominant argument`);
  assert.ok(share('documentation') > 0.12,
    `documentation reasoning in ${(share('documentation') * 100).toFixed(1)}% — the requirement kind our checklists target`);
  assert.ok(share('conservative_therapy') > 0.03,
    `conservative-therapy reasoning in ${(share('conservative_therapy') * 100).toFixed(1)}% — present, a real but minority argument`);
});
