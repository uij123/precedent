// PA-graph harness: the parser is tested against a checked-in fixture with
// every known document wrinkle, and the resolver is tested for determinism
// the same way the synthetic core is — every question asked twice must match
// itself, and must survive a serialization round trip of its inputs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBscList, effectiveDateFrom } from '../src/pa-graph/parse-bsc-list.js';
import { resolve } from '../src/pa-graph/resolve.js';
import { parseCsvLine } from '../src/pa-graph/imr.js';

const dir = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(dir, 'fixtures', 'bsc-list-sample.txt'), 'utf8');

test('pa-parse: effective date read from the document itself', () => {
  assert.equal(effectiveDateFrom(fixture), '2026-08-01');
});

test('pa-parse: fixture covers wraps, glue, delegation, changelog', () => {
  const rs = parseBscList(fixture, { sha256: 'fixturesha', fetched_at: '2026-08-03T00:00:00Z' });

  const byPolicy = Object.fromEntries(rs.rules.filter((r) => r.kind === 'code').map((r) => [r.policy, r.codes]));
  // simple row
  assert.deepEqual(byPolicy['Administrative-Medical - Air Ambulance'], ['A0430']);
  // name wrapped across lines before its first code
  assert.deepEqual(byPolicy['Administrative-Medical - Continuous Home Hospice'], ['T2043']);
  // glued name+code ("Remodeling21600")
  assert.deepEqual(byPolicy['Skeletal Remodeling'], ['21600', '21899']);
  // codes continuing on the next line
  assert.deepEqual(byPolicy['Treatment of Varicose Veins/Venous Insufficiency'], ['36465', '36466', '36468']);
  // glued HCPCS ("StimulationC1767")
  assert.deepEqual(byPolicy['Vagus Nerve Stimulation'], ['C1767']);

  // delegated programs became category rules, and their bare repeats were skipped
  const cats = rs.rules.filter((r) => r.kind === 'category');
  assert.deepEqual(cats.map((c) => c.category_key).sort(), ['advanced_imaging', 'oncology', 'spine_surgery']);
  assert.match(cats.find((c) => c.category_key === 'advanced_imaging').delegate, /RadMD/);

  // changelog tail parsed as diff metadata
  assert.deepEqual(rs.changelog, { added: [], removed: ['36471'] });
});

const rulesets = [parseBscList(fixture, { sha256: 'fixturesha', fetched_at: '2026-08-03T00:00:00Z' })];
const ask = (code, over = {}) => resolve(rulesets, { payer: 'blueshield_ca', lob: 'commercial', code, asOf: '2026-08-03', ...over });

test('pa-resolve: explicit code → prior_auth with policy and source', () => {
  const r = ask('36465');
  assert.equal(r.requirement_type, 'prior_auth');
  assert.deepEqual(r.policies, ['Treatment of Varicose Veins/Venous Insufficiency']);
  assert.equal(r.source.sha256, 'fixturesha');
  assert.ok(r.derivation.some((d) => d.step === 'explicit_code_match'));
});

test('pa-resolve: 72148 → delegated via curated advanced-imaging map', () => {
  const r = ask('72148');
  assert.equal(r.requirement_type, 'prior_auth_delegated');
  assert.match(r.delegate, /RadMD/);
  assert.ok(r.derivation.some((d) => d.step === 'category_match_curated'));
});

test('pa-resolve: unlisted code → no_prior_auth_listed, with the absence cited', () => {
  const r = ask('99213');
  assert.equal(r.requirement_type, 'no_prior_auth_listed');
  assert.ok(r.derivation.some((d) => d.step === 'not_listed'));
});

test('pa-resolve: unknowns are explicit, never guessed', () => {
  assert.equal(ask('99213', { payer: 'anthem_ca' }).reason, 'payer_not_ingested');
  assert.equal(ask('99213', { lob: 'medi-cal' }).reason, 'line_not_ingested');
  assert.equal(ask('banana').reason, 'invalid_code');
  assert.equal(ask('36465', { asOf: '2026-07-01' }).reason, 'line_not_ingested'); // before effective date
});

test('pa-resolve: deterministic — every question twice, plus round-trip parity', () => {
  const questions = ['36465', '72148', '73721', '99213', 'A0430', 'C1767', '0075T'];
  const cloned = JSON.parse(JSON.stringify(rulesets));
  for (const code of questions) {
    const a = ask(code);
    const b = ask(code);
    assert.deepEqual(a, b, `same question twice differs for ${code}`);
    const c = resolve(cloned, { payer: 'blueshield_ca', lob: 'commercial', code, asOf: '2026-08-03' });
    assert.deepEqual(a, c, `round-tripped ruleset differs for ${code}`);
  }
});

const kaiser = JSON.parse(readFileSync(join(dir, '..', 'data', 'pa', 'kaiser-ca-model.2026-01-01.json'), 'utf8'));
const anthem = JSON.parse(readFileSync(join(dir, '..', 'data', 'pa', 'anthem-ca-lookup.2026-01-01.json'), 'utf8'));

test('pa-resolve: Kaiser integrated model → referral_only by structural default', () => {
  const r = resolve([kaiser], { payer: 'kaiser_ca', lob: 'commercial', code: '72148', asOf: '2026-08-03' });
  assert.equal(r.requirement_type, 'referral_only');
  assert.ok(r.derivation.some((d) => d.step === 'line_default'));
});

test('pa-resolve: Anthem lookup-tool line → UNKNOWN with the pointer, never a guess', () => {
  const r = resolve([anthem], { payer: 'anthem_ca', lob: 'commercial', code: '72148', asOf: '2026-08-03' });
  assert.equal(r.requirement_type, 'unknown');
  assert.equal(r.reason, 'lookup_tool_line');
  assert.match(r.detail, /lookup-tool|Lookup Tool/i);
});

test('pa-resolve: service-name lists — imaging delegates, everything else UNKNOWN not exempt', () => {
  const hn = {
    payer_id: 'healthnet_ca', payer_name: 'Health Net of California', lob: 'medi-cal',
    match_basis: 'service_names', effective_from: '2026-07-09', sha256: 'hnsha', fetched_at: 'x',
    document: { title: 't', url: 'u' },
    rules: [
      { kind: 'category', requirement: 'prior_auth_delegated', policy: 'Diagnostic procedures', delegate: 'Evolent Specialty Services, Inc.', category_key: 'advanced_imaging' },
      { kind: 'code', requirement: 'prior_auth', policy: 'Proprietary laboratory analyses', codes: ['0457U'] },
      { kind: 'service', requirement: 'prior_auth', policy: 'Hernia repair', adult: true, pediatric: true },
    ],
  };
  const q = (code) => resolve([hn], { payer: 'healthnet_ca', lob: 'medi-cal', code, asOf: '2026-08-03' });
  assert.equal(q('72148').requirement_type, 'prior_auth_delegated');
  assert.match(q('72148').delegate, /Evolent/);
  assert.equal(q('0457U').requirement_type, 'prior_auth');
  const miss = q('99213');
  assert.equal(miss.requirement_type, 'unknown');
  assert.equal(miss.reason, 'service_name_list');
});

test('pa-imr: quote-aware CSV line parsing', () => {
  assert.deepEqual(
    parseCsvLine('"a","b ""quoted"", with comma",42,'),
    ['a', 'b "quoted", with comma', '42', ''],
  );
});
