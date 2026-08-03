// End-to-end replay test (spec §12.3): replay a consult → interjection fires →
// checklist → approve → verdict → graph updated → a second, similar consult
// produces a BETTER prediction. This asserts the learning loop itself.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { createLocalBus } from '../src/adapters/bus/local.js';
import { createLocalGraph } from '../src/adapters/graph/local.js';
import { createLocalEmail } from '../src/adapters/email/local.js';
import { createMeter } from '../src/adapters/llm/meter.js';
import { createLLM } from '../src/adapters/llm/index.js';
import { createCases } from '../src/services/cases.js';
import { createChainRunner } from '../src/adapters/rocketride/index.js';
import { createChainService } from '../src/services/chains.js';
import { createPayerSim } from '../src/services/payersim-http.js';
import { startIngest } from '../src/services/ingest.js';
import { createGuild } from '../src/services/guild.js';
import { createConsults } from '../src/services/consults.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = (id) => JSON.parse(readFileSync(join(root, 'data', 'consults', `${id}.json`), 'utf8'));
const tmp = mkdtempSync(join(tmpdir(), 'precedent-e2e-'));

let bus, graph, consults, cases, guild, sim, events;

before(async () => {
  const config = {
    forceLocal: ['bus', 'graph', 'llm', 'email', 'rocketride'],
    anthropicApiKey: '', rocketrideApiKey: '', guildWorkspace: '',
    maxInterjectionsPerConsult: 2, payerPort: 0,
  };
  bus = createLocalBus();
  graph = createLocalGraph();
  const meter = createMeter();
  const llm = await createLLM(config, meter);
  const email = createLocalEmail({ outDir: join(tmp, 'outbox') });
  const emailIdem = {
    async send({ key, subject, text }) { return email.send({ to: 't@t', from: 'p@t', subject, text }); },
  };
  cases = createCases({ bus, graph });
  sim = createPayerSim({ port: 0, delayMs: 0 });
  config.payerPort = await sim.listen();
  const runner = await createChainRunner(config);
  guild = createGuild({ llm, config });
  events = [];
  const chains = createChainService({
    runner, graph, bus, email: emailIdem, cases, config,
    attachmentsDir: join(tmp, 'att'),
    onVerdict: (v) => consults.handleVerdict(v),
  });
  consults = createConsults({
    bus, graph, llm, cases, guild, chains, config,
    emit: (type, payload) => events.push({ type, payload }),
  });
  startIngest({ bus, graph });
});

after(async () => { await sim.close(); });

const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));

async function runConsult(scriptId) {
  const caseRec = await consults.startReplay(script(scriptId), { speedMs: 1 });
  // wait for the replay to finish feeding utterances through the bus
  for (let i = 0; i < 100; i++) {
    await settle(30);
    if (events.some((e) => e.type === 'consult_done' && e.payload.case_id === caseRec.case_id)) break;
  }
  await settle(100);
  return caseRec;
}

function interjectionsFor(caseId) {
  return consults.chatlog(caseId).filter((m) => m.kind === 'interjection');
}

test('e2e: full loop — denial teaches, second consult predicts better', async () => {
  // ---- Consult A: BluePeak, 4 weeks. Graph is EMPTY for BluePeak. ----
  const a = await runConsult('c-bluepeak-4wk');
  const intA = interjectionsFor(a.case_id);
  assert.ok(intA.length >= 1, 'interjection fired for consult A');
  assert.ok(intA.length <= 2, 'rate limit respected');
  assert.match(intA[0].text, /no precedents/i, 'first-ever prediction is honest: UNKNOWN, insufficient memory');

  // Doctor proceeds anyway → checklist → approve → DENIED → graph learns.
  const approvalA = await consults.prepareSubmission(a.case_id);
  const checklistMsgA = consults.chatlog(a.case_id).find((m) => m.kind === 'checklist');
  assert.ok(checklistMsgA, 'checklist posted to chat');
  assert.ok(!checklistMsgA.data.checklist.some((i) => i.key === 'pt_notes'),
    'nothing learned yet → PT notes NOT auto-included');

  await consults.resolveApproval(approvalA.approval_id, 'approved');
  for (let i = 0; i < 100 && cases.get(a.case_id).state !== 'CLOSED'; i++) await settle(50);
  assert.equal(cases.get(a.case_id).state, 'CLOSED');
  assert.equal(cases.get(a.case_id).outcome, 'DENIED');

  const reqs = await graph.getRequirements('bluepeak');
  const codes = reqs.map((r) => r.code).sort();
  assert.deepEqual(codes, ['PT_NOTES_MISSING', 'THERAPY_DURATION_INSUFFICIENT'],
    'the denial taught BluePeak\'s requirements');

  // ---- Consult B: BluePeak, 7 weeks (since mid-June), notes available. ----
  const b = await runConsult('c-bluepeak-7wk');
  const intB = interjectionsFor(b.case_id);
  assert.ok(intB.length >= 1, 'interjection fired for consult B');
  assert.doesNotMatch(intB.at(-1).text, /no precedents/i, 'memory no longer empty');
  assert.match(intB.at(-1).text, /APPROVAL expected/i, 'second prediction is sharper: LIKELY_APPROVED');

  const approvalB = await consults.prepareSubmission(b.case_id);
  const checklistMsgB = consults.chatlog(b.case_id).find((m) => m.kind === 'checklist');
  assert.ok(checklistMsgB.data.checklist.some((i) => i.key === 'pt_notes' && i.included),
    'checklist auto-includes PT notes BECAUSE of the learned denial');

  await consults.resolveApproval(approvalB.approval_id, 'approved');
  for (let i = 0; i < 100 && cases.get(b.case_id).state !== 'CLOSED'; i++) await settle(50);
  assert.equal(cases.get(b.case_id).outcome, 'APPROVED', 'first-pass approval after learning');

  // The loop is closed: our approval strengthened the requirements further.
  const reqsAfter = await graph.getRequirements('bluepeak');
  const therapy = reqsAfter.find((r) => r.code === 'THERAPY_DURATION_INSUFFICIENT');
  assert.ok(therapy.evidence_count >= 2, 'approval evidence strengthened the learned rule');
  assert.equal(therapy.approved_at_min, 7, 'approval bound recorded');
});

test('e2e: red-flag consult routes to expedited pathway', async () => {
  const c = await runConsult('c-redflag');
  const ints = interjectionsFor(c.case_id);
  assert.ok(ints.length >= 1);
  assert.match(ints.at(-1).text, /EXPEDITED|Red flags/i);
  const approval = await consults.prepareSubmission(c.case_id);
  await consults.resolveApproval(approval.approval_id, 'approved');
  for (let i = 0; i < 100 && cases.get(c.case_id).state !== 'CLOSED'; i++) await settle(50);
  assert.equal(cases.get(c.case_id).outcome, 'EXPEDITED');
});
