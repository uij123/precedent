// Execution harness (spec §12.2): submit-chain and appeal path against the
// payer simulator in fast mode. Asserts final graph state, exactly one email
// per submission_id (mock sink = local inbox), and idempotency (double-fire
// the trigger, assert a single submission).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalBus } from '../src/adapters/bus/local.js';
import { createLocalGraph } from '../src/adapters/graph/local.js';
import { createLocalEmail } from '../src/adapters/email/local.js';
import { createCases } from '../src/services/cases.js';
import { createChainRunner } from '../src/adapters/rocketride/index.js';
import { createChainService } from '../src/services/chains.js';
import { createPayerSim } from '../src/services/payersim-http.js';
import { startIngest } from '../src/services/ingest.js';
import { buildChecklist } from '../src/core/decide.js';

const tmp = mkdtempSync(join(tmpdir(), 'precedent-exec-'));
let bus, graph, email, emailRaw, cases, runner, chains, sim, port, verdicts;

before(async () => {
  bus = createLocalBus();
  graph = createLocalGraph();
  emailRaw = createLocalEmail({ outDir: join(tmp, 'outbox') });
  // idempotent wrapper equivalent to adapters/email/index.js
  const seen = new Set();
  email = {
    async send({ key, subject, text }) {
      if (seen.has(key)) return { duplicate: true };
      seen.add(key);
      return emailRaw.send({ to: 'sink@test', from: 'precedent@test', subject, text });
    },
  };
  cases = createCases({ bus, graph });
  sim = createPayerSim({ port: 0, delayMs: 0 });
  port = await sim.listen();
  runner = await createChainRunner({ rocketrideApiKey: '', forceLocal: [] });
  verdicts = [];
  chains = createChainService({
    runner, graph, bus, email, cases,
    config: { payerPort: port },
    attachmentsDir: join(tmp, 'att'),
    onVerdict: (v) => verdicts.push(v),
  });
  startIngest({ bus, graph });
});

after(async () => { await sim.close(); });

async function settle() { await new Promise((r) => setTimeout(r, 50)); }

test('submit-chain: denied first contact, write-back, exactly-one email', async () => {
  const caseRec = await cases.open({
    case_id: 'case-t1', consult_id: 'c-t1',
    patient: { id: 'p-t1', name: 'Maria Alvarez' }, payer_id: 'bluepeak',
  });
  const facts = { therapy_weeks: 4, pt_notes_available: true, redflags: 'absent' };
  const checklist = buildChecklist({ payerId: 'bluepeak', facts, requirements: [] }); // empty memory → no pt_notes attached

  const { submission_id, pending } = await chains.submitCase({ caseRec, facts, checklist, delayMs: 0 });
  await pending; await settle();

  assert.equal(submission_id, 'sub-case-t1-a1');
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].verdict.outcome, 'DENIED');
  assert.deepEqual(
    [...verdicts[0].verdict.reason_codes].sort(),
    ['PT_NOTES_MISSING', 'THERAPY_DURATION_INSUFFICIENT'],
  );

  // Write-back: outcome landed on the submission and the payer learned requirements.
  const sub = await graph.getSubmission(submission_id);
  assert.equal(sub.outcome.outcome, 'DENIED');
  const reqs = await graph.getRequirements('bluepeak');
  const codes = reqs.map((r) => r.code).sort();
  assert.deepEqual(codes, ['PT_NOTES_MISSING', 'THERAPY_DURATION_INSUFFICIENT']);
  assert.equal(reqs.find((r) => r.code === 'THERAPY_DURATION_INSUFFICIENT').params.required_weeks, 6);

  // Mirrored into the network feed, marked so ingest doesn't double-learn.
  const mirrored = bus.history('network.events').filter((e) => e.mirrored_from === submission_id);
  assert.equal(mirrored.length, 1);
  assert.equal(reqs.find((r) => r.code === 'PT_NOTES_MISSING').evidence_count, 1, 'no double-learning from mirror');

  // Exactly two emails: submission confirmation + verdict.
  assert.equal(emailRaw.count(), 2);

  // Case reached VERDICT_RECEIVED via SUBMITTED and AWAITING_PAYER.
  const c = cases.get('case-t1');
  assert.equal(c.state, 'VERDICT_RECEIVED');
  const visited = c.history.map((h) => h.state);
  for (const s of ['EXECUTING', 'SUBMITTED', 'AWAITING_PAYER', 'VERDICT_RECEIVED']) {
    assert.ok(visited.includes(s), `visited ${s}`);
  }
});

test('idempotency: double-fire same submission_id → single run, no extra email', async () => {
  const caseRec = cases.get('case-t1');
  const facts = { therapy_weeks: 4, pt_notes_available: true, redflags: 'absent' };
  const checklist = buildChecklist({ payerId: 'bluepeak', facts, requirements: [] });
  const emailsBefore = emailRaw.count();

  const dup = await runner.trigger('submit-chain', {
    key: 'sub-case-t1-a1',
    input: { case_id: 'case-t1', consult_id: 'c-t1', patient: caseRec.patient, payer_id: 'bluepeak', submission_id: 'sub-case-t1-a1', facts, checklist, delay_ms: 0 },
  });
  await settle();
  assert.equal(dup.status, 'duplicate');
  assert.equal(emailRaw.count(), emailsBefore, 'no additional emails on duplicate trigger');
  assert.equal(verdicts.length, 1, 'chain did not run again');
});

test('appeal path: meridian order-form denial → fixes → resubmit → approved', async () => {
  const caseRec = await cases.open({
    case_id: 'case-t2', consult_id: 'c-t2',
    patient: { id: 'p-t2', name: 'Priya Sharma' }, payer_id: 'meridian',
  });
  const facts = { therapy_weeks: 5, pt_notes_available: true, redflags: 'absent' };
  const checklist = buildChecklist({ payerId: 'meridian', facts, requirements: [] }); // order form not learned yet

  const { pending } = await chains.submitCase({ caseRec, facts, checklist, delayMs: 0 });
  await pending; await settle();
  const v1 = verdicts.at(-1);
  assert.equal(v1.verdict.outcome, 'DENIED');
  assert.deepEqual(v1.verdict.reason_codes, ['ORDER_FORM_MISSING']);

  // Deterministic appeal analysis: fixable by attaching the form.
  const analysis = chains.appealFixes({ verdict: v1.verdict, facts, checklist });
  assert.equal(analysis.appealable, true);
  assert.ok(analysis.checklist.some((i) => i.key === 'order_form' && i.included));

  // Human approves the corrected checklist → attempt 2.
  const { submission_id: sub2, pending: p2 } = await chains.submitCase({
    caseRec, facts, checklist: analysis.checklist, attempt: 2, delayMs: 0,
  });
  await p2; await settle();
  assert.equal(sub2, 'sub-case-t2-a2');
  assert.equal(verdicts.at(-1).verdict.outcome, 'APPROVED');
  const sub = await graph.getSubmission(sub2);
  assert.equal(sub.outcome.outcome, 'APPROVED');
});

test('unfixable appeal: therapy duration short → recommendation, not appeal', async () => {
  const facts = { therapy_weeks: 4, pt_notes_available: true, redflags: 'absent' };
  const analysis = chains.appealFixes({
    verdict: {
      outcome: 'DENIED',
      reason_codes: ['THERAPY_DURATION_INSUFFICIENT'],
      reason_params: { THERAPY_DURATION_INSUFFICIENT: { required_weeks: 6 } },
    },
    facts,
    checklist: buildChecklist({ payerId: 'bluepeak', facts, requirements: [] }),
  });
  assert.equal(analysis.appealable, false);
  assert.match(analysis.unfixable[0].action, /2 more week/);
});

test('expedited: red flags present → EXPEDITED, no reasons', async () => {
  const caseRec = await cases.open({
    case_id: 'case-t3', consult_id: 'c-t3',
    patient: { id: 'p-t3', name: 'Elena Petrova' }, payer_id: 'bluepeak',
  });
  const facts = { therapy_weeks: 1, pt_notes_available: false, redflags: 'present' };
  const checklist = buildChecklist({ payerId: 'bluepeak', facts, requirements: [] });
  const { pending } = await chains.submitCase({ caseRec, facts, checklist, delayMs: 0 });
  await pending; await settle();
  assert.equal(verdicts.at(-1).verdict.outcome, 'EXPEDITED');
});
