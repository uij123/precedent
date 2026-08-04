/* Precedent front-end: SSE-driven, no framework.
   Three views: Consult (practitioner), Practice manager, Admin (demo/tech). */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const state = {
  scripts: [], adapters: [], cases: { cases: [], attribution: null, alerts: [] },
  rulebook: [], metrics: null, emails: [], ticker: [], chatlogs: {},
  activeCaseId: null, activeConsultId: null,
  bgRunning: false, fast: false, harnessLines: [],
  mic: null, micOn: false, speaker: 'auto', payerDelay: 20000,
};

// Coalesce bursty SSE re-renders (a 500-event seed fires hundreds per second).
const rafQueue = {};
function coalesce(key, fn) {
  if (rafQueue[key]) return;
  rafQueue[key] = true;
  requestAnimationFrame(() => { rafQueue[key] = false; fn(); });
}
const pendingFlash = [];

// Payer names come from the server's rulebook; procedures are a fixed registry.
const payerNm = (id) => state.rulebook.find((p) => p.payer_id === id)?.name.split(' ')[0] || id;
const PROC_SHORT = {
  72148: 'MRI lumbar', 70551: 'MRI brain', 73721: 'MRI knee',
  72131: 'CT lumbar', 74177: 'CT abdomen', 76700: 'US abdomen',
};
const procShort = (cpt) => PROC_SHORT[cpt] || 'MRI lumbar';
const sentenceCase = (s) => { const t = String(s).replaceAll('_', ' ').toLowerCase(); return t.charAt(0).toUpperCase() + t.slice(1); };
const OUTCOME_DOT = { APPROVED: 'd-ok', EXPEDITED: 'd-warn', DENIED: 'd-alert' };

// ---------- boot ----------
async function boot() {
  const s = await (await fetch('/api/state')).json();
  Object.assign(state, {
    scripts: s.scripts, adapters: s.adapters, cases: s.cases, rulebook: s.rulebook,
    metrics: s.metrics, emails: s.emails, ticker: s.ticker, chatlogs: s.chatlogs,
    archived: s.archived_consults || [],
    bgRunning: s.background.running, payerDelay: s.payer_delay_ms,
  });
  $('email-mode').textContent = s.email_mode === 'resend' ? 'Real email via Resend' : 'Local outbox, .eml on disk. Set RESEND_API_KEY for real email.';
  const open = s.cases.cases.filter((c) => c.state !== 'CLOSED');
  if (open.length) setActiveCase(open[open.length - 1].case_id, open[open.length - 1].consult_id);
  renderAll();
  connectSSE();
}

function renderAll() {
  renderAdapters(); renderScripts(); renderTicker(); renderMetrics(); renderRulebook();
  renderInbox(); renderChat(); renderCaptured(); renderHistory(); renderManager(); renderControls();
  renderCoverage();
}

// ---------- SSE ----------
function connectSSE() {
  const es = new EventSource('/api/events');
  const on = (t, f) => es.addEventListener(t, (e) => f(JSON.parse(e.data)));
  on('consult_open', ({ case_id, consult_id }) => {
    clearConsultPanels();
    state.facts = {};
    setActiveCase(case_id, consult_id);
    renderChat(); renderCaptured(); renderHistory();
  });
  on('utterance', (u) => { if (u.consult_id === state.activeConsultId) addUtterance(u); });
  on('fact', (f) => { if (f.consult_id === state.activeConsultId) addFact(f); });
  on('chat', ({ case_id, message }) => {
    (state.chatlogs[case_id] ||= []).push(message);
    if (!state.activeCaseId && case_id !== 'global') state.activeCaseId = case_id;
    if (case_id === (state.activeCaseId || 'global')) renderChat();
  });
  on('case', () => {});
  on('cases', (snap) => { state.cases = snap; renderManager(); renderHistory(); syncActive(); });
  on('ticker', (evt) => { state.ticker.push(evt); if (state.ticker.length > 60) state.ticker.shift(); coalesce('ticker', renderTicker); });
  on('metrics', (m) => { state.metrics = m; coalesce('metrics', () => { renderMetrics(); renderManager(); }); });
  on('learned', ({ rulebook, codes, payer_id }) => {
    state.rulebook = rulebook;
    pendingFlash.push(...codes.map((c) => `${payer_id}:${c}`));
    coalesce('rulebook', () => renderRulebook(pendingFlash.splice(0)));
  });
  on('email', (msg) => { state.emails.unshift(msg); renderInbox(); });
  on('harness', (h) => {
    if (h.line) state.harnessLines.push(h.line);
    if (h.done) state.harnessLines.push(`— done (exit ${h.code}) ${h.summary || ''}`);
    if (state.harnessLines.length > 300) state.harnessLines.splice(0, 100);
    renderHarness();
  });
  on('reset', () => location.reload());
  es.onerror = () => setTimeout(() => { es.close(); connectSSE(); }, 2000);
}

function syncActive() {
  const active = state.cases.cases.find((c) => c.case_id === state.activeCaseId);
  const btn = $('prepare');
  if (active) {
    const ready = ['PREDICTED', 'CONSULT'].includes(active.state);
    btn.disabled = !ready;
  } else {
    btn.disabled = true;
  }
}

function setActiveCase(caseId, consultId) {
  state.activeCaseId = caseId;
  state.viewingArchived = false;
  if (consultId) state.activeConsultId = consultId;
  $('chat-input').disabled = false; $('chat-send').disabled = false;
  syncActive();
}

function activePayerId() {
  return state.cases.cases.find((c) => c.case_id === state.activeCaseId)?.payer_id || null;
}

// ---------- consult view ----------
function addUtterance(u) {
  const el = document.createElement('div');
  el.className = `utt ${u.speaker}`;
  el.innerHTML = `<span class="who">${u.speaker === 'doctor' ? 'Doctor' : 'Patient'}</span>${esc(u.text)}`;
  $('transcript').appendChild(el);
  $('transcript').scrollTop = 1e9;
}

// Humanized capture — no variable names in the practitioner view.
const FACT_TEXT = {
  payer_mention: (v) => `Payer: ${payerNm(v)}`,
  therapy_weeks: (v) => `Documented therapy: ${v} week${Number(v) === 1 ? '' : 's'}`,
  therapy_provider: (v) => `Therapy provider: ${v}`,
  pt_notes_available: (v) => (v === true || v === 'true') ? 'PT notes available' : 'PT notes not on file',
  redflags: (v) => v === 'absent' ? 'No red flags' : v === 'present' ? 'Red flags present' : `Red flags: ${v}`,
  imaging_intent: (v) => (v === true || v === 'true') ? 'Imaging planned' : 'No imaging planned',
};

function addFact({ fact }) {
  state.facts ||= {};
  state.facts[fact.type] = fact.value; // latest wins
  renderCaptured();
}

function renderCaptured() {
  const facts = state.facts || {};
  const entries = Object.entries(facts);
  if (!entries.length) {
    $('captured').innerHTML = '<div class="rb-empty">Details appear here as the visit is transcribed.</div>';
    return;
  }
  // one wrapping line, not chips — five facts never clip in a narrow column
  $('captured').innerHTML = `<p class="captured-line">${entries.map(([t, v]) =>
    esc((FACT_TEXT[t] || ((x) => `${sentenceCase(t)}: ${x}`))(v))).join(' · ')}</p>`;
}

// ---------- past visits ----------
function renderHistory() {
  const rows = [...state.cases.cases].sort((a, b) => (a.opened_at < b.opened_at ? 1 : -1));
  const archived = (state.archived || []).map((a) => `
    <div class="visit ${state.activeConsultId === a.consult_id && !state.activeCaseId ? 'active' : ''}" data-archived="${a.consult_id}">
      <div class="v-top">
        <span class="dot8 d-muted"></span>
        <span class="v-name">${esc(a.patient_name || a.consult_id)}</span>
        <span class="v-time">${a.started_at ? new Date(a.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</span>
      </div>
      <div class="v-meta">${a.payer_id ? `${payerNm(a.payer_id)} · ` : ''}Archived</div>
    </div>`).join('');
  if (!rows.length && !archived) {
    $('history').innerHTML = '<div class="rb-empty">Visits appear here as they happen.</div>';
    return;
  }
  const clean = (state.activeCaseId || state.activeConsultId)
    ? '<div class="visit v-new" data-clean="1"><div class="v-top">Start clean</div></div>' : '';
  $('history').innerHTML = clean + rows.map((c) => {
    const dot = c.state === 'CLOSED'
      ? (OUTCOME_DOT[c.outcome] || 'd-ok')
      : `d-${(c.blocking || 'agent').toLowerCase()}`;
    const status = c.state === 'CLOSED' ? sentenceCase(c.outcome || 'Closed') : sentenceCase(c.state);
    return `<div class="visit ${c.case_id === state.activeCaseId ? 'active' : ''}" data-visit="${c.case_id}" data-consult="${c.consult_id}">
      <div class="v-top">
        <span class="dot8 ${dot}"></span>
        <span class="v-name">${esc(c.patient?.name || c.case_id)}</span>
        <span class="v-time">${new Date(c.opened_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
      <div class="v-meta">${procShort(c.cpt)} · ${payerNm(c.payer_id)} · ${status}</div>
    </div>`;
  }).join('') + archived;
}

// Delegated: rows re-render on every case tick.
$('history').addEventListener('click', async (e) => {
  if (e.target.closest('[data-clean]')) return startClean();
  const arch = e.target.closest('.visit[data-archived]');
  if (arch) return selectArchived(arch.dataset.archived);
  const row = e.target.closest('.visit[data-visit]');
  if (row) await selectVisit(row.dataset.visit, row.dataset.consult);
});

async function selectArchived(consultId) {
  state.activeCaseId = null;
  state.activeConsultId = consultId;
  state.viewingArchived = true;
  $('transcript').innerHTML = '';
  state.facts = {};
  let chatLog = [];
  try {
    const d = await (await fetch(`/api/consult/${consultId}/history`)).json();
    for (const u of d.utterances || []) addUtterance(u);
    state.facts = d.facts || {};
    chatLog = d.chat || [];
  } catch { /* nothing recorded */ }
  renderCaptured(); renderHistory(); syncActive();
  $('chat').innerHTML = '<div class="msg system">Archived visit, restored from the memory graph. Review only.</div>'
    + chatHtml(chatLog, { archived: true });
  $('chat').scrollTop = 0;
  $('chat-input').disabled = true; $('chat-send').disabled = true;
}

function startClean() {
  state.activeCaseId = null;
  state.activeConsultId = null;
  state.viewingArchived = false;
  $('chat-input').disabled = false; $('chat-send').disabled = false;
  clearConsultPanels();
  renderChat(); renderHistory(); syncActive();
}

async function selectVisit(caseId, consultId) {
  state.activeCaseId = caseId;
  state.activeConsultId = consultId;
  state.viewingArchived = false;
  $('chat-input').disabled = false; $('chat-send').disabled = false;
  $('transcript').innerHTML = '';
  state.facts = {};
  try {
    const d = await (await fetch(`/api/consult/${consultId}/history`)).json();
    for (const u of d.utterances || []) addUtterance(u);
    state.facts = d.facts || {};
  } catch { /* visit predates this server run; chat still loads */ }
  renderCaptured(); renderChat(); renderHistory(); syncActive();
}

function renderChat() {
  if (state.viewingArchived) return; // archived chat is rendered by selectArchived
  const log = state.chatlogs[state.activeCaseId || 'global'] || [];
  if (!log.length) {
    $('chat').innerHTML = '<div class="msg system">No visit in progress. You can still ask the memory graph: "what does BluePeak require?" — or paste a read-only Cypher query.</div>';
    return;
  }
  $('chat').innerHTML = chatHtml(log);
  $('chat').scrollTop = 1e9;
}

function chatHtml(log, { archived = false } = {}) {
  const payer = activePayerId();
  return log.map((m) => {
    if (m.role === 'approval') {
      const items = (m.data?.checklist || []).map((i) => `
        <div class="chk">
          <span class="dot8 ${i.satisfied ? 'd-ok' : 'd-alert'}"></span>
          <span>${esc(i.label)} <span class="why ${i.reason === 'learned-requirement' ? 'learned' : ''}">${i.reason === 'learned-requirement' ? '· learned from denials' : '· clinical standard'}</span>${i.requirement_code && payer ? ` <button class="srclink" onclick="openSource('${payer}','${i.requirement_code}')">Sources</button>` : ''}</span>
        </div>`).join('');
      const pending = !m.resolved && !archived;
      return `<div class="msg agent checklist-card" data-mid="${m.id}">
        <span class="agentname">Human approval gate. Nothing executes before approval.</span>
        ${esc(m.text)}<div class="items">${items}</div>
        <div class="approve-row">${pending
          ? `<button class="btn primary" onclick="approve('${m.data.approval_id}','approved','${m.id}')">Approve and execute</button>
             <button class="btn" onclick="approve('${m.data.approval_id}','rejected','${m.id}')">Reject</button>`
          : `<span class="hint">${esc(m.resolved || (archived ? 'Decided in the live visit.' : ''))}</span>`}
        </div></div>`;
    }
    const cls = m.role === 'user' ? 'user' : m.role === 'system' ? 'system' : `agent ${m.kind || ''}`;
    const name = m.agent ? `<span class="agentname">${esc(m.agent)}</span>` : '';
    const claims = (m.data?.claims || []).filter((c) => c.code);
    const claimPayer = m.data?.payer_id || payer;
    const srcRow = claims.length && claimPayer
      ? `<div class="srcrow">${claims.map((c) => `<button class="srclink" onclick="openSource('${claimPayer}','${c.code}')">Sources · ${esc(REQ_SHORT[c.code] || sentenceCase(c.code))}</button>`).join('')}</div>`
      : '';
    return `<div class="msg ${cls}">${name}${esc(m.text)}${srcRow}</div>`;
  }).join('');
}

// ---------- sources panel (click-to-audit provenance) ----------
window.openSource = async (payerId, code) => {
  const panel = $('source-panel');
  panel.classList.remove('hidden');
  $('source-title').textContent = 'Sources';
  $('source-body').innerHTML = '<div class="rb-empty">Loading evidence…</div>';
  try {
    const d = await (await fetch(`/api/source/${payerId}/${encodeURIComponent(code)}`)).json();
    $('source-title').textContent = d.label || sentenceCase(code);
    const parts = [];
    parts.push(`<div class="src-meta">${esc(payerNm(payerId))}${d.requirement?.params?.required_weeks ? ` · requires ${d.requirement.params.required_weeks} weeks` : ''}</div>`);
    if (d.requirement) {
      parts.push(`<p class="src-lede">Learned from ${d.requirement.evidence_count} observed outcome${d.requirement.evidence_count === 1 ? '' : 's'} on the network · confidence ${Math.round((d.requirement.confidence || 0) * 100)}%. Nobody typed this rule in; the events below are its entire basis.</p>`);
    }
    if (d.standard) {
      parts.push(`<p class="src-lede">Clinical standard: ${esc(d.standard)}</p>`);
    }
    if (d.evidence?.length) {
      parts.push('<div class="src-list">' + d.evidence.map((e) => `
        <div class="src-row">
          <span class="dot8 ${OUTCOME_DOT[e.outcome] || 'd-warn'}"></span>
          <span class="src-main">${sentenceCase(e.outcome || 'outcome')} · ${e.clinic_id ? esc(e.clinic_id) : 'this clinic'}${e.therapy_weeks != null ? ` · ${e.therapy_weeks} wk documented` : ''}</span>
          <span class="src-when">${e.ts ? new Date(e.ts).toLocaleString() : ''}</span>
        </div>`).join('') + '</div>');
    } else if (!d.standard) {
      parts.push('<div class="rb-empty">No recorded evidence for this requirement yet.</div>');
    }
    $('source-body').innerHTML = parts.join('');
  } catch {
    $('source-body').innerHTML = '<div class="rb-empty">Could not load sources. Try again.</div>';
  }
};
$('source-close').onclick = () => $('source-panel').classList.add('hidden');
// Delegated: the table re-renders on every metrics tick, so row-level handlers
// would be replaced mid-click; the container is stable.
$('claims').addEventListener('click', async (e) => {
  const go = e.target.closest('.goto');
  if (go) {
    switchTab('clinic');
    await selectVisit(go.dataset.gotoCase, go.dataset.gotoConsult);
    return;
  }
  const tr = e.target.closest('tr[data-case]');
  if (tr) openCase(tr.dataset.case);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('source-panel').classList.add('hidden'); });

// ---------- admin renders ----------
async function renderCoverage() {
  try {
    const d = await (await fetch('/api/pa/coverage')).json();
    if (!d.lines?.length) {
      $('coverage').innerHTML = '<div class="rb-empty">No payer lines ingested yet. Run the pa-graph CLI.</div>';
      return;
    }
    const rows = d.lines.map((l) => `<tr>
      <td>${esc(l.payer_name)}</td>
      <td>${esc(l.lob)}</td>
      <td>${esc(l.basis)}</td>
      <td class="num">${l.distinct_codes || '–'}</td>
      <td class="num">${l.delegated_programs || '–'}</td>
      <td>${l.effective_from || '–'}</td>
      <td>${l.snapshot ? `<span class="cell-note">${l.snapshot}</span>` : '–'}</td>
    </tr>`).join('');
    const imr = d.imr
      ? `<p class="cap-line">Plus ${d.imr.determinations.toLocaleString()} state IMR determinations as outcome evidence · ${Math.round((d.imr.imaging_overturn_rate || 0) * 100)}% of appealed imaging denials overturned.</p>`
      : '';
    $('coverage').innerHTML = `<table class="claims-table">
      <thead><tr><th>Payer</th><th>Line</th><th>Basis</th><th class="num">Codes</th><th class="num">Delegations</th><th>Effective</th><th>Snapshot</th></tr></thead>
      <tbody>${rows}</tbody></table>${imr}`;
  } catch {
    $('coverage').innerHTML = '<div class="rb-empty">Coverage inventory unavailable.</div>';
  }
}

function renderAdapters() {
  $('adapters').innerHTML = state.adapters.map((a) =>
    `<span class="badge" title="${esc(a.detail)}"><span class="dot8 ${a.mode === 'live' ? 'd-ok' : 'd-warn'}"></span>${esc(a.name)} · ${a.mode === 'live' ? 'live' : 'fallback'}</span>`).join('');
}

function renderScripts() {
  $('script-pick').innerHTML = state.scripts.map((s) =>
    `<option value="${s.id}">${esc(s.patient)} · ${payerNm(s.payer_id)} · ${esc((s.title.split('—')[1] || s.title).trim())}</option>`).join('');
}

function renderTicker() {
  if (!state.ticker.length) {
    $('ticker').innerHTML = '<div class="rb-empty">No network traffic yet. Start the background world.</div>';
    return;
  }
  $('ticker').innerHTML = state.ticker.slice(-40).reverse().map((e) => `
    <div class="tick ${e.mirrored_from ? 'ours' : ''}">
      <span class="dot8 ${OUTCOME_DOT[e.outcome] || 'd-warn'}"></span>
      <span class="oc-word">${sentenceCase(e.outcome)}</span>
      <span class="who">${e.mirrored_from ? 'This clinic' : esc(e.clinic_id)}</span>
      <span class="det">${procShort(e.cpt)} · ${payerNm(e.payer_id)} · ${e.packet?.therapy_weeks ?? '?'} wk${e.reason_codes?.length ? ' · ' + e.reason_codes.join(', ') : ''}</span>
    </div>`).join('');
}

const REQ_SHORT = {
  THERAPY_DURATION_INSUFFICIENT: 'Therapy duration',
  PT_NOTES_MISSING: 'PT notes',
  REDFLAG_SCREEN_MISSING: 'Red-flag screen',
  ORDER_FORM_MISSING: 'Order form',
  DIAGNOSIS_CODE_INVALID: 'Diagnosis code',
};

function renderRulebook(flash = []) {
  $('rulebook').innerHTML = state.rulebook.map((p) => {
    const reqs = p.requirements.filter((r) => r.evidence_count > 0);
    const rows = reqs.length ? reqs.map((r) => `
      <div class="rb-req ${flash.includes(`${p.payer_id}:${r.code}`) ? 'flash' : ''}" onclick="openSource('${p.payer_id}','${r.code}')" title="${esc(r.code)} — click for evidence">
        <span class="code">${REQ_SHORT[r.code] || esc(r.code)}${r.params?.required_weeks ? ` ≥ ${r.params.required_weeks} wk` : ''}</span>
        <span class="bar"><i style="width:${Math.round(r.confidence * 100)}%"></i></span>
        <span class="ev">${r.evidence_count} ev · ${Math.round(r.confidence * 100)}%</span>
      </div>`).join('')
      : '<div class="rb-empty">Nothing learned yet. Outcomes appear here as the network runs.</div>';
    return `<div class="rb-payer"><div class="name">${esc(p.name)}</div><div class="rb-reqs">${rows}</div></div>`;
  }).join('');
  renderGraphViz();
}

// ---------- memory graph (admin): bipartite payer → requirement view ----------
function renderGraphViz() {
  const svg = $('graph-viz'); if (!svg) return;
  const w = svg.clientWidth || 460;
  const rowH = 26, blockGap = 16, padT = 8;
  const xDot = 12, xName = 24, xEdge0 = 148, xReq = Math.max(180, Math.min(230, w * 0.44));
  let y = padT;
  const blocks = state.rulebook.map((p) => {
    const reqs = p.requirements.filter((r) => r.evidence_count > 0);
    const h = Math.max(1, reqs.length) * rowH;
    const b = { p, reqs, y0: y, h };
    y += h + blockGap;
    return b;
  });
  const H = y - blockGap + padT;
  svg.setAttribute('viewBox', `0 0 ${w} ${H}`);
  svg.style.height = `${H}px`;
  svg.innerHTML = blocks.map((b) => {
    const py = b.y0 + b.h / 2;
    let out = `<circle cx="${xDot}" cy="${py}" r="4"/><text x="${xName}" y="${py + 4}" class="g-name">${esc(b.p.name)}</text>`;
    if (!b.reqs.length) {
      out += `<text class="g-meta" x="${xReq}" y="${py + 4}">Nothing learned yet</text>`;
      return out;
    }
    out += b.reqs.map((r, i) => {
      const ry = b.y0 + i * rowH + rowH / 2;
      const wk = r.params?.required_weeks ? ` ≥ ${r.params.required_weeks} wk` : '';
      return `<line x1="${xEdge0}" y1="${py}" x2="${xReq - 8}" y2="${ry}"/>
        <g class="g-node" onclick="openSource('${b.p.payer_id}','${r.code}')">
          <circle cx="${xReq}" cy="${ry}" r="4"/>
          <text x="${xReq + 12}" y="${ry + 4}">${REQ_SHORT[r.code] || esc(r.code)}${wk}</text>
          <text class="g-meta" x="${w - 4}" y="${ry + 4}" text-anchor="end">${r.evidence_count} ev · ${Math.round(r.confidence * 100)}%</text>
        </g>`;
    }).join('');
    return out;
  }).join('');
}

async function runGraphQuery(q) {
  $('graph-q').value = q;
  $('graph-out').innerHTML = '<div class="graph-note">Running…</div>';
  try {
    const r = await fetch('/api/graph/query', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cypher: q }),
    });
    const d = await r.json();
    if (!r.ok) { $('graph-out').innerHTML = `<div class="graph-note">${esc(d.error)}</div>`; return; }
    if (!d.rows.length) { $('graph-out').innerHTML = '<div class="graph-note">No rows.</div>'; return; }
    $('graph-out').innerHTML = `<div class="graph-note">${d.rows.length} row${d.rows.length === 1 ? '' : 's'}, live from the memory graph.</div>
      <table><thead><tr>${d.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>${d.rows.map((row) => `<tr>${row.map((v) => `<td>${esc(v ?? '–')}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  } catch {
    $('graph-out').innerHTML = '<div class="graph-note">Query failed. Is the server up?</div>';
  }
}
$('graph-run').onclick = () => { const q = $('graph-q').value.trim(); if (q) runGraphQuery(q); };
$('graph-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('graph-run').click(); });
document.querySelectorAll('.graph-canned .srclink').forEach((b) => { b.onclick = () => runGraphQuery(b.dataset.q); });

function renderInbox() {
  if (!state.emails.length) {
    $('inbox').innerHTML = '<div class="rb-empty">No emails sent yet.</div>';
    return;
  }
  $('inbox').innerHTML = state.emails.slice(0, 12).map((e) => `
    <div class="mail"><div class="subj">${esc(e.subject)}</div>
    <div class="meta">to ${esc(e.to)} · ${new Date(e.ts).toLocaleTimeString()}${e.attachments?.length ? ` · ${e.attachments.length} PDF${e.attachments.length === 1 ? '' : 's'} attached` : ''}</div></div>`).join('');
}

function renderHarness() {
  $('harness-out').innerHTML = state.harnessLines.map((l) => {
    const cls = /✔|# pass/.test(l) ? 'pass' : /✖|# fail [1-9]/.test(l) ? 'fail' : '';
    return `<div class="${cls}">${esc(l)}</div>`;
  }).join('');
  $('harness-out').scrollTop = 1e9;
}

// ---------- manager renders ----------
function renderMetrics() {
  const m = state.metrics; if (!m) return;
  const series = m.first_pass_rate_series || [];
  drawRateChart(series);
  if (series.length) $('stat-rate').textContent = `${Math.round(series[series.length - 1].rate * 100)}%`;
  $('stat-ttv').textContent = m.median_ttv_ms ? fmtMs(m.median_ttv_ms) : '–';
  $('stat-events').textContent = m.outcomes_seen;
  renderRoi();
}

// single-series line: 2px accent stroke, hairline grid anchored at 0/50/100%,
// crosshair + tooltip on hover (dataviz skill: line charts ship a hover layer)
let chartGeom = null;
function drawRateChart(series) {
  const svg = $('rate-chart');
  const w = svg.clientWidth || 320, h = 96;
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  if (series.length < 2) {
    svg.innerHTML = `<text class="ax" x="0" y="${h / 2}">No outcomes yet. Start the background world.</text>`;
    chartGeom = null;
    return;
  }
  const x0 = 44, x1 = w - 8, yTop = 10, yBot = h - 10;
  const X = (i) => x0 + (i / (series.length - 1)) * (x1 - x0);
  const Y = (r) => yBot - r * (yBot - yTop);
  const d = series.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(p.rate).toFixed(1)}`).join(' ');
  const grid = [[Y(1), '100%'], [Y(0.5), '50%'], [Y(0), '0%']]
    .map(([y, l]) => `<line class="grid" x1="${x0}" y1="${y}" x2="${x1}" y2="${y}"/><text class="ax" x="${x0 - 8}" y="${y + 4}" text-anchor="end">${l}</text>`).join('');
  svg.innerHTML = `${grid}<path class="line" d="${d}"/>
    <circle cx="${X(series.length - 1).toFixed(1)}" cy="${Y(series[series.length - 1].rate).toFixed(1)}" r="4" fill="#1B6FA8" stroke="#FFFFFF" stroke-width="2"/>
    <g id="chart-hover"></g>`;
  chartGeom = { series, xs: series.map((_, i) => X(i)), ys: series.map((p) => Y(p.rate)), yTop, yBot, w, h };
}

$('rate-chart').addEventListener('mousemove', (ev) => {
  if (!chartGeom) return;
  const svg = $('rate-chart'), box = svg.getBoundingClientRect();
  const mx = (ev.clientX - box.left) * (chartGeom.w / box.width);
  let i = 0, best = Infinity;
  chartGeom.xs.forEach((x, k) => { const d = Math.abs(x - mx); if (d < best) { best = d; i = k; } });
  const p = chartGeom.series[i], x = chartGeom.xs[i], y = chartGeom.ys[i];
  document.getElementById('chart-hover').innerHTML =
    `<line class="grid" x1="${x}" y1="${chartGeom.yTop}" x2="${x}" y2="${chartGeom.yBot}"/>
     <circle cx="${x}" cy="${y}" r="4" fill="#1B6FA8" stroke="#FFFFFF" stroke-width="2"/>`;
  const tip = $('chart-tip'), panel = $('performance-panel').getBoundingClientRect();
  tip.textContent = `${Math.round(p.rate * 100)}% · ${new Date(p.ts).toLocaleTimeString()}`;
  tip.classList.remove('hidden');
  tip.style.left = `${Math.max(0, Math.min(ev.clientX - panel.left + 12, panel.width - 120))}px`;
  tip.style.top = `${box.top - panel.top + (y * box.height) / chartGeom.h - 32}px`;
});
$('rate-chart').addEventListener('mouseleave', () => {
  $('chart-tip').classList.add('hidden');
  const g = document.getElementById('chart-hover');
  if (g) g.innerHTML = '';
});
window.addEventListener('resize', () => {
  if (state.metrics) drawRateChart(state.metrics.first_pass_rate_series || []);
  renderGraphViz();
});

function renderManager() {
  const snap = state.cases;
  // alerts
  $('alerts').innerHTML = snap.alerts.map((a) =>
    `<div class="alert"><span class="dot8 d-alert"></span>${esc(a.patient?.name || a.case_id)} has waited ${fmtMs(a.waiting_ms)} for human approval.</div>`).join('');
  $('alert-dot').classList.toggle('hidden', snap.alerts.length === 0);

  renderClaims();
}

function renderClaims() {
  const snap = state.cases;
  const per = new Map((state.metrics?.per_case || []).map((r) => [r.case_id, r]));
  if (!snap.cases.length) {
    $('claims').innerHTML = '<div class="rb-empty">No claims yet. They appear here as visits happen.</div>';
    return;
  }
  // Agents are never a resting bottleneck: their states are transient, and
  // every human-blocked state names the action that unblocks it.
  const NEXT_STEP = {
    CONSULT: 'Finish the visit. The copilot is listening.',
    PREDICTED: 'Review the prediction and prepare the submission.',
    AWAITING_HUMAN_APPROVAL: 'Approve or reject the packet.',
    EXECUTING: 'None. Automatic; resolves in seconds.',
    SUBMITTED: 'None. Automatic; resolves in seconds.',
    VERDICT_RECEIVED: 'None. Automatic; resolves in seconds.',
    APPEALING: 'None. Automatic; resolves in seconds.',
    AWAITING_PAYER: 'None. The payer is processing.',
  };
  const ACTIONABLE = new Set(['PREDICTED', 'AWAITING_HUMAN_APPROVAL']);
  const rows = [...snap.cases].sort((a, b) => (a.opened_at < b.opened_at ? 1 : -1)).map((c) => {
    const r = per.get(c.case_id);
    const stage = c.state === 'CLOSED'
      ? `<span class="cell-status"><span class="dot8 ${OUTCOME_DOT[c.outcome] || 'd-ok'}"></span>${c.outcome ? sentenceCase(c.outcome) : 'Closed'}</span>`
      : sentenceCase(c.state);
    const waiting = c.blocking
      ? `<span class="cell-status"><span class="dot8 d-${c.blocking.toLowerCase()}"></span>${c.blocking.toLowerCase()}</span>` : '–';
    const next = c.state === 'CLOSED' ? '–'
      : `${NEXT_STEP[c.state] || ''}${ACTIONABLE.has(c.state)
        ? ` <button class="srclink goto" data-goto-case="${c.case_id}" data-goto-consult="${c.consult_id}">Open in Consult</button>` : ''}`;
    const money = (v, show) => (show ? usd(v) : '–');
    return `<tr data-case="${c.case_id}">
      <td>${esc(c.patient?.name || c.case_id)}${c.attempt > 1 ? ` <span class="cell-note">attempt ${c.attempt}</span>` : ''}</td>
      <td>${payerNm(c.payer_id)}</td>
      <td>${procShort(c.cpt)}</td>
      <td>${stage}</td>
      <td class="num">${c.state === 'CLOSED' ? '–' : fmtMs(c.in_state_ms)}</td>
      <td>${waiting}</td>
      <td class="next">${next}</td>
      <td class="num">${money(r?.manual_baseline_usd, r?.submitted)}</td>
      <td class="num">${money(r?.actual_usd, !!r)}</td>
      <td class="num">${money(r?.roi_usd, r?.submitted)}</td>
    </tr>`;
  }).join('');
  const roi = state.metrics?.roi;
  const totals = roi ? `<tr class="totals">
      <td>Total</td><td></td><td></td><td></td><td></td><td></td><td></td>
      <td class="num">${usd(roi.manual_equivalent_usd)}</td>
      <td class="num">${usd(roi.actual_usd)}</td>
      <td class="num">${usd(roi.saved_usd)}</td>
    </tr>` : '';
  $('claims').innerHTML = `<table class="claims-table">
    <thead><tr>
      <th>Patient</th><th>Payer</th><th>Study</th><th>Stage</th><th class="num">In stage</th><th>Waiting on</th>
      <th>Next step</th>
      <th class="num">Would cost</th><th class="num">Actual</th><th class="num">Saved</th>
    </tr></thead>
    <tbody>${rows}${totals}</tbody>
  </table>`;
}

function renderRoi() {
  const r = state.metrics?.roi; if (!r) return;
  $('roi-head').textContent = `Today: ${r.cases} claim${r.cases === 1 ? '' : 's'} submitted. ${usd(r.manual_equivalent_usd)} of manual-equivalent work done for ${usd(r.actual_usd)}.${r.any_estimated_tokens ? ' Token costs estimated, no API key.' : ''}`;
  $('roi-manual').textContent = usd(r.manual_equivalent_usd);
  $('roi-actual').textContent = usd(r.actual_usd);
  $('roi-saved').textContent = usd(r.saved_usd);
  $('roi-minutes').textContent = `${r.staff_minutes_freed.toFixed(0)}m`;
  $('roi-split').textContent = `Actual: ${usd(r.token_usd)} metered tokens + ${usd(r.human_usd)} human approval time.`;
}

window.openCase = async (caseId) => {
  const d = await (await fetch(`/api/case/${caseId}`)).json();
  $('case-drawer').classList.remove('hidden');
  $('drawer-title').textContent = `${d.case.patient?.name || caseId} · ${procShort(d.case.cpt)} · ${sentenceCase(d.case.state)} (${caseId})`;
  const tl = d.case.timeline.map((t, i) => {
    const next = d.case.timeline[i + 1];
    const dur = next ? Date.parse(next.at) - Date.parse(t.at) : Date.now() - Date.parse(t.at);
    return `<span class="seg">${sentenceCase(t.state)}${t.note ? ` · ${esc(t.note)}` : ''}<small>${new Date(t.at).toLocaleTimeString()} · ${fmtMs(dur)}</small></span>`;
  }).join('<span class="tl-arrow">→</span>');
  const rec = d.receipt;
  // one row per purpose — a consult logs one meter line per LLM call
  const byPurpose = new Map();
  for (const l of rec?.lines || []) {
    const k = `${l.purpose}${l.estimated ? ' (est.)' : ''}`;
    const a = byPurpose.get(k) || { n: 0, tin: 0, tout: 0, usd: 0 };
    a.n += 1; a.tin += l.tokens_in; a.tout += l.tokens_out; a.usd += l.usd;
    byPurpose.set(k, a);
  }
  const lines = [...byPurpose].map(([k, a]) =>
    `<tr><td>${esc(k)}${a.n > 1 ? ` ×${a.n}` : ''}</td><td>${a.tin}+${a.tout} tok</td><td>${usd(a.usd)}</td></tr>`).join('');
  $('drawer-body').innerHTML = `
    <div class="tl">${tl}</div>
    ${rec ? `<div class="receipt"><table>
      ${lines}
      <tr><td>Human approval time</td><td>${fmtMs(rec.human_ms)}</td><td>${usd(rec.human_usd)}</td></tr>
      <tr class="total"><td>Actual cost</td><td></td><td>${usd(rec.actual_usd)}</td></tr>
      <tr><td>Manual baseline${rec.denial_avoided ? ', including avoided-denial rework' : ''}</td><td></td><td>${usd(rec.manual_baseline_usd)}</td></tr>
      <tr class="total"><td>Saved on this claim</td><td></td><td>${usd(rec.roi_usd)}</td></tr>
    </table></div>` : '<div class="rb-empty">Costs appear once the claim is submitted.</div>'}`;
  $('case-drawer').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};

// ---------- actions ----------
window.approve = async (approvalId, decision, mid) => {
  const log = state.chatlogs[state.activeCaseId] || [];
  const m = log.find((x) => x.id === mid);
  if (m) m.resolved = decision === 'approved' ? 'Approved. Executing.' : 'Rejected.';
  renderChat();
  await fetch(`/api/approval/${approvalId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision }) });
};

$('replay').onclick = async () => {
  clearConsultPanels();
  switchTab('clinic');
  const r = await (await fetch('/api/consult/replay', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ script_id: $('script-pick').value, speed_ms: Number($('speed').value) }),
  })).json();
  setActiveCase(r.case.case_id, r.case.consult_id);
};

$('prepare').onclick = async () => {
  $('prepare').disabled = true;
  await fetch(`/api/case/${state.activeCaseId}/prepare`, { method: 'POST' });
};

const sendChat = async () => {
  const text = $('chat-input').value.trim();
  if (!text) return;
  $('chat-input').value = '';
  await fetch(`/api/chat/${state.activeCaseId || 'global'}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
};
$('chat-send').onclick = sendChat;
$('chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

$('bg-toggle').onclick = async () => {
  const [min, max] = $('bg-rate').value.split(',').map(Number);
  state.bgRunning = !state.bgRunning;
  await fetch('/api/background', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: state.bgRunning ? 'start' : 'stop', min_ms: min, max_ms: max }) });
  renderControls();
};
$('bg-rate').onchange = async () => {
  const [min, max] = $('bg-rate').value.split(',').map(Number);
  await fetch('/api/background', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ min_ms: min, max_ms: max }) });
};
$('bg-burst').onclick = () => fetch('/api/background', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ burst: 10 }) });
$('bg-seed').onclick = () => {
  $('bg-seed').disabled = true;
  fetch('/api/background', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ burst: 500 }) })
    .finally(() => { $('bg-seed').disabled = false; });
};

$('fast-toggle').onclick = async () => {
  state.fast = !state.fast;
  const r = await (await fetch('/api/payer-config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fast: state.fast }) })).json();
  state.payerDelay = r.delay_ms;
  renderControls();
};

$('harness-run').onclick = () => {
  state.harnessLines = ['Running node --test…'];
  renderHarness();
  fetch('/api/harness/run', { method: 'POST' });
};

$('reset').onclick = async () => {
  if (confirm('Wipe the memory graph? The rulebook starts from zero.')) await fetch('/api/reset', { method: 'POST' });
};

function renderControls() {
  $('bg-toggle').textContent = state.bgRunning ? 'Stop' : 'Start';
  $('bg-toggle').classList.toggle('on', state.bgRunning);
  $('fast-toggle').textContent = state.fast ? 'Verdicts in 3 s' : `Verdicts in ${Math.round(state.payerDelay / 1000)} s`;
  $('fast-toggle').classList.toggle('on', state.fast);
}

function clearConsultPanels() {
  $('transcript').innerHTML = '';
  state.facts = {};
  renderCaptured();
}

// ---------- tabs ----------
// Admin stays out of sight for real users; open ?admin=1 to drive demos.
// The F-key replay fallback works either way — the button exists, just hidden.
if (!new URLSearchParams(location.search).has('admin')) $('tab-admin').classList.add('hidden');
$('tab-clinic').onclick = () => switchTab('clinic');
$('tab-manager').onclick = () => switchTab('manager');
$('tab-admin').onclick = () => switchTab('admin');
function switchTab(t) {
  for (const v of ['clinic', 'manager', 'admin']) {
    $(`view-${v}`).classList.toggle('hidden', t !== v);
    $(`tab-${v}`).classList.toggle('active', t === v);
  }
  // charts can only measure their width while their view is visible
  if (t === 'manager' && state.metrics) drawRateChart(state.metrics.first_pass_rate_series || []);
  if (t === 'admin') renderGraphViz();
}

// ---------- live mic (Web Speech API) + fallback switch ----------
const SPEAKER_LABEL = { auto: 'Speaker: Auto', doctor: 'Speaker: Doctor', patient: 'Speaker: Patient' };
$('speaker').onclick = () => {
  state.speaker = state.speaker === 'auto' ? 'doctor' : state.speaker === 'doctor' ? 'patient' : 'auto';
  $('speaker').textContent = SPEAKER_LABEL[state.speaker];
};

$('mic').onclick = async () => {
  if (state.micOn) return stopMic();
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return alert('Speech recognition is unavailable in this browser. Use the demo driver in Admin; the pipeline is identical downstream.');
  clearConsultPanels();
  const r = await (await fetch('/api/consult/live', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ patient_name: 'Live patient', payer_id: null }),
  })).json();
  setActiveCase(r.case.case_id, r.case.consult_id);
  const rec = new SR();
  rec.continuous = true; rec.interimResults = false; rec.lang = 'en-US';
  rec.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) {
        fetch(`/api/consult/${state.activeConsultId}/utterance`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ speaker: state.speaker, text: e.results[i][0].transcript.trim() }),
        });
      }
    }
  };
  rec.onend = () => { if (state.micOn) rec.start(); };
  rec.start();
  state.mic = rec; state.micOn = true;
  $('mic').textContent = 'End visit';
  $('mic').classList.add('on'); $('rec-dot').classList.remove('hidden');
  $('speaker').classList.remove('hidden');
};

function stopMic() {
  state.micOn = false;
  state.mic?.stop();
  $('mic').textContent = 'Start visit';
  $('mic').classList.remove('on'); $('rec-dot').classList.add('hidden');
  $('speaker').classList.add('hidden');
}

// F = the fallback switch (spec §6): one keystroke swaps live mic for scripted
// replay through the exact same pipeline.
document.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 'f' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
    stopMic();
    $('replay').click();
  }
});

// ---------- utils ----------
function fmtMs(ms) {
  if (ms == null) return '–';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
function usd(n) { const v = n ?? 0; return `$${(Math.abs(v) < 0.005 ? 0 : v).toFixed(2)}`; }

boot();
