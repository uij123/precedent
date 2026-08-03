// Precedent — entry point. Boots the payer simulator, the LaserData bus, the
// FalkorDB graph, ingest workers, the background world, chains, Guild agents,
// consult sessions, chat, metrics, and the web UI (SSE + REST + static).
import { createServer } from 'node:http';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { config } from './src/config.js';
import { readJson, sendJson } from './src/util.js';
import { REQ_LABELS, CLINICAL_STANDARDS } from './src/core/decide.js';
import { adapterStatus } from './src/adapters/status.js';
import { createBus } from './src/adapters/bus/index.js';
import { createGraph } from './src/adapters/graph/index.js';
import { createLLM } from './src/adapters/llm/index.js';
import { createMeter } from './src/adapters/llm/meter.js';
import { createEmail } from './src/adapters/email/index.js';
import { createChainRunner } from './src/adapters/rocketride/index.js';
import { createPayerSim } from './src/services/payersim-http.js';
import { startIngest } from './src/services/ingest.js';
import { createCases } from './src/services/cases.js';
import { createChainService } from './src/services/chains.js';
import { createGuild } from './src/services/guild.js';
import { createConsults } from './src/services/consults.js';
import { createChat } from './src/services/chat.js';
import { createMetrics } from './src/services/metrics.js';
import { createBackgroundWorld } from './src/world/background.js';

const root = dirname(fileURLToPath(import.meta.url));
const consultDir = join(root, 'data', 'consults');

// ---------- SSE hub ----------
const sseClients = new Set();
function broadcast(type, payload) {
  const frame = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) res.write(frame);
}

// ---------- boot ----------
console.log('Precedent booting…');
const meter = createMeter();
const payerSim = createPayerSim({ port: config.payerPort, delayMs: config.payerDelayMs });
await payerSim.listen();
console.log(`[payer-sim] listening on :${config.payerPort} (delay ${payerSim.getDelay()}ms)`);

const bus = await createBus(config);
const graph = await createGraph(config);
const llm = await createLLM(config, meter);
const email = await createEmail(config, { outDir: join(root, 'var', 'outbox') });
const cases = createCases({ bus, graph });
const runner = await createChainRunner(config, {
  onStep: (step) => broadcast('chainstep', step),
});
const guild = createGuild({ llm, config });

const chains = createChainService({
  runner, graph, bus, email, cases, config,
  attachmentsDir: join(root, 'var', 'attachments'),
  onVerdict: (v) => consults.handleVerdict(v),
});
const consults = createConsults({ bus, graph, llm, cases, guild, chains, config, emit: broadcast });

// Shared read-only Cypher gate — the admin console and the chat both use it.
async function runReadOnlyCypher(cypher) {
  const q = String(cypher || '').trim();
  if (!q) return { error: 'Empty query.' };
  if (!/^(MATCH|OPTIONAL\s+MATCH|RETURN|WITH|UNWIND)\b/i.test(q)
    || /\b(CREATE|MERGE|DELETE|DETACH|SET|REMOVE|DROP|LOAD)\b/i.test(q)) {
    return { error: 'Read-only queries only. Start with MATCH, RETURN, WITH, or UNWIND.' };
  }
  if (!graph.rawQuery) return { error: 'Cypher queries need the FalkorDB backend. This instance is running the in-memory fallback.' };
  return graph.rawQuery(q);
}

const chat = createChat({ llm, consults, graph, graphQuery: runReadOnlyCypher });
const metrics = createMetrics({ bus, cases, meter });

startIngest({
  bus, graph,
  onLearned: async ({ payer_id, codes, source }) => {
    broadcast('learned', { payer_id, codes, source, rulebook: await graph.rulebook() });
  },
});

const background = createBackgroundWorld({
  publish: (topic, evt) => bus.publish(topic, evt),
  seed: config.worldSeed, minMs: config.backgroundMinMs, maxMs: config.backgroundMaxMs,
});

// stream → UI relays
bus.subscribe('network.events', (evt) => { broadcast('ticker', evt); broadcast('metrics', metrics.snapshot()); });
bus.subscribe('payer.verdicts', (evt) => broadcast('verdict', evt));
bus.subscribe('case.lifecycle', (evt) => {
  broadcast('case', evt);
  broadcast('cases', cases.snapshot(config));
});
email.subscribe((msg) => broadcast('email', msg));

const scripts = () => readdirSync(consultDir).filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(consultDir, f), 'utf8')));

// ---------- HTTP ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${config.appPort}`);
  const path = url.pathname;
  const seg = path.split('/').filter(Boolean);

  try {
    // ---- SSE ----
    if (path === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive',
      });
      res.write(`event: hello\ndata: {}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    // ---- state snapshot ----
    if (path === '/api/state' && req.method === 'GET') {
      const caseSnap = cases.snapshot(config);
      const chatlogs = {};
      for (const c of caseSnap.cases) chatlogs[c.case_id] = consults.chatlog(c.case_id);
      return sendJson(res, 200, {
        adapters: adapterStatus(),
        scripts: scripts().map((s) => ({ id: s.consult_id, title: s.title, patient: s.patient.name, payer_id: s.payer_id })),
        cases: caseSnap,
        rulebook: await graph.rulebook(),
        counts: await graph.counts(),
        metrics: metrics.snapshot(),
        emails: email.list(20),
        email_mode: email.mode,
        background: background.status(),
        payer_delay_ms: payerSim.getDelay(),
        chatlogs,
        archived_consults: (await graph.listConsults(30))
          .filter((a) => !caseSnap.cases.some((c) => c.consult_id === a.consult_id)),
        ticker: bus.history('network.events', 30),
        llm_mode: llm.mode,
        bus_mode: bus.mode,
        graph_mode: graph.mode,
        chain_mode: runner.mode,
      });
    }

    // ---- consult control ----
    if (path === '/api/consult/replay' && req.method === 'POST') {
      const body = await readJson(req);
      const script = scripts().find((s) => s.consult_id === body.script_id);
      if (!script) return sendJson(res, 404, { error: 'unknown script' });
      const caseRec = await consults.startReplay(script, { speedMs: body.speed_ms || 1700 });
      return sendJson(res, 200, { case: caseRec });
    }
    if (path === '/api/consult/live' && req.method === 'POST') {
      const body = await readJson(req);
      const caseRec = await consults.startLive({ patientName: body.patient_name, payerId: body.payer_id || null });
      return sendJson(res, 200, { case: caseRec });
    }
    if (seg[0] === 'api' && seg[1] === 'consult' && seg[3] === 'utterance' && req.method === 'POST') {
      const body = await readJson(req);
      await consults.pushLiveUtterance(seg[2], { speaker: body.speaker || 'doctor', text: body.text });
      return sendJson(res, 200, { ok: true });
    }
    if (seg[0] === 'api' && seg[1] === 'consult' && seg[3] === 'stop' && req.method === 'POST') {
      consults.stop(seg[2]);
      return sendJson(res, 200, { ok: true });
    }

    // ---- the human gate ----
    if (seg[0] === 'api' && seg[1] === 'case' && seg[3] === 'prepare' && req.method === 'POST') {
      const approval = await consults.prepareSubmission(seg[2]);
      return sendJson(res, 200, { approval_id: approval.approval_id });
    }
    if (seg[0] === 'api' && seg[1] === 'approval' && req.method === 'POST') {
      const body = await readJson(req);
      const approval = await consults.resolveApproval(seg[2], body.decision === 'approved' ? 'approved' : 'rejected');
      return sendJson(res, 200, { status: approval.status });
    }

    // ---- chat ----
    if (seg[0] === 'api' && seg[1] === 'chat' && req.method === 'POST') {
      const body = await readJson(req);
      await chat.ask(seg[2], body.text || '');
      return sendJson(res, 200, { ok: true });
    }

    // ---- demo controls ----
    if (path === '/api/background' && req.method === 'POST') {
      const body = await readJson(req);
      if (body.min_ms && body.max_ms) background.setRate(body.min_ms, body.max_ms);
      if (body.action === 'start') background.start();
      if (body.action === 'stop') background.stop();
      if (body.burst) await background.burst(Math.min(1000, body.burst));
      return sendJson(res, 200, background.status());
    }
    if (path === '/api/payer-config' && req.method === 'POST') {
      const body = await readJson(req);
      payerSim.setDelay(body.fast ? config.payerDelayFastMs : config.payerDelayMs);
      return sendJson(res, 200, { delay_ms: payerSim.getDelay() });
    }
    if (path === '/api/reset' && req.method === 'POST') {
      await graph.resetAll();
      broadcast('reset', {});
      return sendJson(res, 200, { ok: true, note: 'graph wiped — memory starts from zero (restart server for a full state reset)' });
    }

    // ---- memory graph: read-only query console (admin + chat) ----
    if (path === '/api/graph/query' && req.method === 'POST') {
      const body = await readJson(req);
      const out = await runReadOnlyCypher(body.cypher);
      return sendJson(res, out.error ? 400 : 200, out);
    }

    // ---- past-visit review: transcript + facts for a consult ----
    if (seg[0] === 'api' && seg[1] === 'consult' && seg[3] === 'history' && req.method === 'GET') {
      const consultId = seg[2];
      // graph first (persists across restarts); bus history as fallback
      let utterances = await graph.getUtterances(consultId);
      if (!utterances.length) {
        utterances = bus.history('consult.utterances', 800)
          .filter((u) => u.consult_id === consultId)
          .sort((a, b) => (a.seq || 0) - (b.seq || 0));
      }
      // replaying a script reuses its consult id — keep only the latest run
      const bySeq = new Map();
      for (const u of utterances) bySeq.set(u.seq, u); // ts-ordered: later runs win
      utterances = [...bySeq.values()].sort((a, b) => (a.seq || 0) - (b.seq || 0));
      const factMap = await graph.getFacts(consultId);
      const facts = {};
      for (const [k, v] of Object.entries(factMap || {})) facts[k] = v?.value ?? v;
      // chat from the same (latest) run as the transcript
      const chatAll = await graph.getChatMessages(consultId);
      const latestCase = chatAll.length ? chatAll[chatAll.length - 1].case_id : null;
      const chat = chatAll.filter((m) => m.case_id === latestCase);
      return sendJson(res, 200, { utterances, facts, chat });
    }

    // ---- claim-source audit (spec: every learned claim is traceable) ----
    if (seg[0] === 'api' && seg[1] === 'source' && seg.length === 4 && req.method === 'GET') {
      const payerId = seg[2];
      const code = decodeURIComponent(seg[3]);
      const reqs = await graph.getRequirements(payerId);
      const r = (reqs || []).find((x) => x.code === code) || null;
      const evidence = await graph.getRequirementEvidence(payerId, code, 12);
      return sendJson(res, 200, {
        payer_id: payerId,
        code,
        label: REQ_LABELS[code] || code,
        requirement: r && r.evidence_count > 0
          ? { confidence: r.confidence, evidence_count: r.evidence_count, params: r.params || {} }
          : null,
        evidence,
        standard: CLINICAL_STANDARDS[code] || null,
      });
    }

    // ---- manager console data ----
    if (seg[0] === 'api' && seg[1] === 'case' && seg.length === 3 && req.method === 'GET') {
      const snap = cases.snapshot(config).cases.find((c) => c.case_id === seg[2]);
      if (!snap) return sendJson(res, 404, { error: 'unknown case' });
      return sendJson(res, 200, { case: snap, receipt: metrics.receipt(seg[2]), chatlog: consults.chatlog(seg[2]) });
    }

    // ---- harness (shown to judges, spec §12.4) ----
    if (path === '/api/harness/run' && req.method === 'POST') {
      const child = spawn(process.execPath, ['--test', '--test-reporter=spec'], { cwd: root, env: { ...process.env, FORCE_COLOR: '0' } });
      let out = '';
      const push = (chunk) => {
        out += chunk;
        for (const line of chunk.toString().split('\n')) if (line.trim()) broadcast('harness', { line });
      };
      child.stdout.on('data', push);
      child.stderr.on('data', push);
      child.on('close', (code) => broadcast('harness', { done: true, code, summary: (out.match(/# (tests|pass|fail) \d+/g) || []).join(' · ') }));
      return sendJson(res, 200, { started: true });
    }

    // ---- static ----
    let file = path === '/' ? '/index.html' : path;
    const full = join(root, 'public', file);
    if (existsSync(full) && !file.includes('..')) {
      res.writeHead(200, { 'content-type': MIME[extname(full)] || 'application/octet-stream' });
      return res.end(readFileSync(full));
    }
    sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('[http]', path, e);
    sendJson(res, 500, { error: e.message });
  }
});

server.listen(config.appPort, () => {
  console.log(`\nPrecedent up:  http://localhost:${config.appPort}`);
  console.log(`Payer sim:     http://localhost:${config.payerPort}  (POST /payer/{id}/submit)`);
  console.log(`Adapters:      ${adapterStatus().map((a) => `${a.name}=${a.mode}`).join(' · ')}\n`);
});
