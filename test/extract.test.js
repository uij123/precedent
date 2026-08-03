// Extraction engine tests: every consult script, replayed utterance by
// utterance through the deterministic extractor, must yield the facts the
// scenario was generated from — including relative-date inference.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFacts } from '../src/core/extract-rules.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'consults');
const CONSULT_DATE = new Date('2026-08-03T09:00:00'); // hackathon day — pins relative dates

function runScript(doc) {
  const acc = {};
  let prev = null;
  for (const u of doc.utterances) {
    for (const f of extractFacts(u, { consultDate: CONSULT_DATE, prev })) {
      acc[f.type] = f.value; // latest wins
    }
    prev = u;
  }
  return acc;
}

for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
  const doc = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  test(`extract: ${doc.consult_id}`, () => {
    const facts = runScript(doc);

    // Every script mentions its payer and has exactly one imaging-intent moment.
    assert.equal(facts.payer_mention, doc.payer_id, 'payer detected');
    assert.equal(facts.imaging_intent, true, 'imaging intent detected');

    // Scenario-specific expectations baked in at generation time.
    for (const [key, expected] of Object.entries(doc.scenario.expect)) {
      if (key === 'redflags' && expected === 'not_discussed') {
        assert.equal(facts.redflags, undefined, 'redflags must NOT be emitted when never discussed');
      } else {
        assert.equal(facts[key], expected, `fact ${key}`);
      }
    }

    // Relative-date scripts: verify the inferred week counts for Aug 3 2026.
    if (doc.consult_id === 'c-bluepeak-7wk') assert.equal(facts.therapy_weeks, 7, 'mid-June → 7 weeks');
    if (doc.consult_id === 'c-calwest-memorial') assert.equal(facts.therapy_weeks, 10, 'Memorial Day → 10 weeks');
  });
}

test('extract: emits nothing on smalltalk', () => {
  const facts = extractFacts(
    { speaker: 'patient', text: 'Thanks, doctor. See you next time.' },
    { consultDate: CONSULT_DATE, prev: null },
  );
  assert.deepEqual(facts, []);
});
