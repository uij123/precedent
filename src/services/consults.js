// Consult sessions: the voice pipeline's downstream half plus the proactive
// brain. Utterances (replayed script OR live mic — identical from here, spec
// §6) flow through the consult.utterances topic; each one is extracted into
// Facts, written to the graph, and checked for the interjection moment:
// the instant imaging intent appears, the system speaks first (spec §7).
// Max 2 interjections per consult — restraint is a design rule.
import { predict, buildChecklist } from '../core/decide.js';
import { payerName, procedureShort } from '../domain/payers.js';
import { id, nowIso, fmtDuration } from '../util.js';

export function createConsults({ bus, graph, llm, cases, guild, chains, config, emit }) {
  const sessions = new Map(); // consult_id -> session state
  const chatlogs = new Map(); // case_id -> messages[]

  function chat(caseId, msg) {
    const rec = { id: id('msg'), ts: nowIso(), ...msg };
    if (!chatlogs.has(caseId)) chatlogs.set(caseId, []);
    chatlogs.get(caseId).push(rec);
    emit('chat', { case_id: caseId, message: rec });
    return rec;
  }

  // ---- the consume path: every utterance, replayed or live, lands here ----
  bus.subscribe('consult.utterances', async (u) => {
    const s = sessions.get(u.consult_id);
    if (!s) return;
    try {
      emit('utterance', u);
      await graph.addUtterance(u.consult_id, u); // transcript persists in the memory graph
      const facts = await llm.extractFacts(
        { speaker: u.speaker, text: u.text },
        { consultDate: s.consultDate, prev: s.prevUtterance },
        s.case_id,
      );
      s.prevUtterance = { speaker: u.speaker, text: u.text };
      for (const f of facts) {
        await graph.addFact(u.consult_id, { type: f.type, value: f.value, seq: u.seq, ts: u.ts });
        s.facts[f.type] = f.value;
        emit('fact', { consult_id: u.consult_id, case_id: s.case_id, fact: f, seq: u.seq });
      }
      if (facts.length) await maybeInterject(s);
    } catch (e) {
      console.error('[consult]', e.message);
    }
  });

  async function currentPrediction(s) {
    const payerId = s.payer_id || s.facts.payer_mention;
    if (!payerId) return null;
    const requirements = await graph.getRequirements(payerId);
    // Attach recent evidence so interjections can cite precedents.
    for (const r of requirements) {
      r.evidence = await graph.getRequirementEvidence(payerId, r.code, 5);
    }
    return { payerId, prediction: predict({ payerId, facts: s.facts, requirements }), requirements };
  }

  async function maybeInterject(s) {
    if (!s.facts.imaging_intent) return;
    if (s.interjections >= config.maxInterjectionsPerConsult) return;
    const ctx = await currentPrediction(s);
    if (!ctx) {
      if (s.interjections === 0) {
        s.interjections += 1;
        chat(s.case_id, {
          role: 'agent', kind: 'interjection',
          text: 'Heads up: an MRI order is coming, but I don\'t know this patient\'s insurer yet. Mention the plan (or set it on the case) and I\'ll check their real approval behavior.',
        });
      }
      return;
    }
    const { prediction, payerId } = ctx;
    const signature = `${prediction.prediction}|${prediction.missing.map((m) => m.code).sort().join(',')}`;
    if (signature === s.lastInterjectionSignature) return; // nothing new to say
    s.interjections += 1;
    s.lastInterjectionSignature = signature;

    const text = interjectionText(payerId, prediction);
    const driving = prediction.missing.length ? prediction.missing : prediction.items;
    chat(s.case_id, {
      role: 'agent', kind: 'interjection', text,
      data: {
        prediction: prediction.prediction, confidence: prediction.confidence,
        missing: prediction.missing.map((m) => ({ code: m.code, label: m.label, detail: m.detail, action: m.action })),
        payer_id: payerId,
        claims: driving.map((m) => ({ code: m.code })),
      },
    });
    await cases.transition(s.case_id, 'PREDICTED', { note: prediction.prediction });
  }

  function interjectionText(payerId, p) {
    const name = payerName(payerId);
    const head = {
      LIKELY_DENIED: `Heads up: this patient is on ${name}. Order today and expect a denial (confidence ${(p.confidence * 100).toFixed(0)}%).`,
      LIKELY_APPROVED: `Good news: this patient is on ${name}. Every requirement the network has learned is satisfied. First-pass approval expected (confidence ${(p.confidence * 100).toFixed(0)}%).`,
      LIKELY_EXPEDITED: `Red flags documented. This qualifies for ${name}'s expedited pathway. Submit immediately; routine requirements don't apply.`,
      UNKNOWN: p.items.length === 0
        ? `This patient is on ${name} — and the memory graph has no precedents for them yet. I can't predict; every verdict on the network is teaching me.`
        : `This patient is on ${name}. Too close to call (confidence ${(p.confidence * 100).toFixed(0)}%).`,
    }[p.prediction];

    const lines = [];
    for (const m of p.missing) {
      const denials = (m.evidence || []).filter((e) => e.outcome === 'DENIED');
      let ev = '';
      if (denials.length) {
        const ago = fmtDuration(Date.now() - Date.parse(denials[0].ts));
        ev = ` ${name} has denied ${denials.length} similar request${denials.length === 1 ? '' : 's'} for this — most recent ${ago} ago.`;
      }
      lines.push(`  · ${m.label}: ${m.detail}${ev}${m.action ? ` Fix: ${m.action}` : ''}`);
    }
    const tail = p.prediction === 'LIKELY_DENIED' || p.prediction === 'UNKNOWN'
      ? '\nAsk me "what if we wait 2 weeks?" — or say the word and I\'ll prepare the packet.'
      : '\nSay the word and I\'ll prepare the packet for your approval.';
    return [head, ...lines].join('\n') + tail;
  }

  return {
    /** Start a scripted consult, replayed through the real stream (spec §6 fallback switch). */
    async startReplay(script, { speedMs = 1700 } = {}) {
      const case_id = `case-${script.consult_id}-${Date.now().toString(36)}`;
      await graph.ensurePatient({ ...script.patient, payer_id: script.payer_id });
      await graph.ensureConsult({ consult_id: script.consult_id, patient_id: script.patient.id, started_at: nowIso() });
      const caseRec = await cases.open({
        case_id, consult_id: script.consult_id, patient: script.patient, payer_id: script.payer_id,
        cpt: script.cpt || '72148',
      });
      const s = {
        consult_id: script.consult_id, case_id, mode: 'replay',
        payer_id: script.payer_id, patient: script.patient,
        consultDate: new Date(), facts: {}, prevUtterance: null,
        interjections: 0, lastInterjectionSignature: null, seq: 0, timer: null,
      };
      sessions.set(script.consult_id, s);
      emit('consult_open', { case_id, consult_id: script.consult_id, mode: 'replay' });
      chat(case_id, { role: 'system', text: `Consult started: ${script.patient.name} · ${payerName(script.payer_id)} · ${script.title}` });

      const utterances = [...script.utterances];
      const tick = async () => {
        if (!sessions.has(script.consult_id)) return;
        const u = utterances.shift();
        if (!u) { emit('consult_done', { consult_id: script.consult_id, case_id }); return; }
        s.seq += 1;
        await bus.publish('consult.utterances', {
          consult_id: script.consult_id, seq: s.seq, speaker: u.speaker, text: u.text, ts: nowIso(),
        });
        s.timer = setTimeout(tick, speedMs);
      };
      tick();
      return caseRec;
    },

    /** Live-mic session: browser speech-to-text posts finalized utterances here. */
    async startLive({ patientName = 'Live patient', payerId = null } = {}) {
      const consult_id = id('c-live');
      const case_id = `case-${consult_id}`;
      const patient = { id: `p-${consult_id}`, name: patientName };
      if (payerId) await graph.ensurePatient({ ...patient, payer_id: payerId });
      await graph.ensureConsult({ consult_id, patient_id: patient.id, started_at: nowIso() });
      const caseRec = await cases.open({ case_id, consult_id, patient, payer_id: payerId, cpt: '72148' });
      sessions.set(consult_id, {
        consult_id, case_id, mode: 'live', payer_id: payerId, patient,
        consultDate: new Date(), facts: {}, prevUtterance: null,
        interjections: 0, lastInterjectionSignature: null, seq: 0, timer: null,
      });
      emit('consult_open', { case_id, consult_id, mode: 'live' });
      chat(case_id, { role: 'system', text: `Live consult started (${patientName}). Speak — the mic feeds the same pipeline as replay.` });
      return caseRec;
    },

    async pushLiveUtterance(consultId, { speaker, text }) {
      const s = sessions.get(consultId);
      if (!s) throw new Error(`no active consult ${consultId}`);
      const resolved = (!speaker || speaker === 'auto') ? classifySpeaker(text, s.lastLiveSpeaker) : speaker;
      s.lastLiveSpeaker = resolved;
      s.seq += 1;
      await bus.publish('consult.utterances', {
        consult_id: consultId, seq: s.seq, speaker: resolved, text, ts: nowIso(),
      });
    },

    stop(consultId) {
      const s = sessions.get(consultId);
      if (s?.timer) clearTimeout(s.timer);
      sessions.delete(consultId);
    },

    /** Doctor's go-ahead: agents debate, checklist is posted, gate closes until Approve. */
    async prepareSubmission(caseId) {
      const s = [...sessions.values()].find((x) => x.case_id === caseId);
      const caseRec = cases.get(caseId);
      if (!caseRec) throw new Error(`unknown case ${caseId}`);
      const facts = s ? s.facts : await graph.getFacts(caseRec.consult_id).then(toPlain);
      const ctx = await (s ? currentPrediction(s) : null)
        || await (async () => {
          const requirements = await graph.getRequirements(caseRec.payer_id);
          return { payerId: caseRec.payer_id, prediction: predict({ payerId: caseRec.payer_id, facts, requirements }), requirements };
        })();

      const debate = await guild.debate({ caseId, payerId: ctx.payerId, facts, prediction: ctx.prediction });
      for (const p of debate.positions) {
        chat(caseId, { role: 'agent', kind: 'debate', agent: p.agent, stance: p.stance, text: `[${p.agent} · ${p.stance}]\n${p.text}` });
      }
      chat(caseId, { role: 'system', kind: 'debate-resolution', text: debate.resolution });

      const checklist = buildChecklist({ payerId: ctx.payerId, facts, requirements: ctx.requirements });
      const approval = guild.requestApproval({ caseId, kind: 'submit', checklist, prediction: ctx.prediction });
      await cases.transition(caseId, 'AWAITING_HUMAN_APPROVAL', { note: 'submit packet' });
      chat(caseId, {
        role: 'approval', kind: 'checklist', approval_id: approval.approval_id,
        text: `Here is exactly what I will claim and attach for ${payerName(ctx.payerId)} — approve to execute:`,
        data: { checklist, approval_id: approval.approval_id, kind: 'submit' },
      });
      return approval;
    },

    /** The human clicks. Approve → chains execute. Reject → nothing does. */
    async resolveApproval(approvalId, decision) {
      const approval = guild.resolveApproval(approvalId, decision);
      const caseRec = cases.get(approval.case_id);
      caseRec.human_ms = (caseRec.human_ms || 0) + (approval.waited_ms || 0);

      if (decision !== 'approved') {
        chat(approval.case_id, { role: 'system', text: 'Rejected — nothing was submitted. The packet stays parked; ask me to prepare it again any time.' });
        await cases.transition(approval.case_id, 'PREDICTED', { note: 'approval rejected' });
        return approval;
      }

      const s = [...sessions.values()].find((x) => x.case_id === approval.case_id);
      const facts = s ? s.facts : toPlain(await graph.getFacts(caseRec.consult_id));
      const attempt = approval.kind === 'appeal' ? (caseRec.attempt || 1) + 1 : caseRec.attempt || 1;
      // ROI: a denial counts as avoided when the packet includes a learned-
      // requirement item this payer previously denied for (spec §11B) — but
      // only if the case actually ends approved (confirmed at verdict time).
      caseRec.denial_avoidance_candidate = approval.checklist.some((i) => i.reason === 'learned-requirement' && i.included && i.satisfied);
      chat(approval.case_id, { role: 'system', text: `Approved. Executing ${approval.kind === 'appeal' ? `appeal (attempt ${attempt})` : 'submission'} via the execution chain. Confirmation email on its way.` });
      await chains.submitCase({ caseRec, facts, checklist: approval.checklist, attempt });
      return approval;
    },

    /** Chains report back here when the payer answers. */
    async handleVerdict({ caseId, input, verdict }) {
      const caseRec = cases.get(caseId);
      const name = payerName(input.payer_id);
      caseRec.denial_avoided = !!caseRec.denial_avoidance_candidate
        && (verdict.outcome === 'APPROVED' || verdict.outcome === 'EXPEDITED');
      if (verdict.outcome === 'APPROVED' || verdict.outcome === 'EXPEDITED') {
        chat(caseId, {
          role: 'agent', kind: 'verdict',
          text: `${name} ${verdict.outcome === 'EXPEDITED' ? 'expedited' : 'approved'} ${input.patient.name}'s ${procedureShort(input.cpt)}${input.attempt > 1 ? ` on appeal (attempt ${input.attempt})` : ' on first pass'}. Outcome email sent; the graph just got smarter.`,
        });
        await cases.transition(caseId, 'CLOSED', { outcome: verdict.outcome });
        return;
      }
      // DENIED → deterministic appeal analysis
      const s = [...sessions.values()].find((x) => x.case_id === caseId);
      const facts = s ? s.facts : toPlain(await graph.getFacts(caseRec.consult_id));
      const analysis = chains.appealFixes({ verdict, facts, checklist: input.checklist });
      const reasons = verdict.reason_codes.map((c) => `  · ${c}`).join('\n');
      if (analysis.appealable) {
        await cases.transition(caseId, 'APPEALING', { note: 'building corrected packet' });
        const approval = guild.requestApproval({ caseId, kind: 'appeal', checklist: analysis.checklist, note: 'corrected packet' });
        await cases.transition(caseId, 'AWAITING_HUMAN_APPROVAL', { note: 'appeal packet' });
        chat(caseId, {
          role: 'approval', kind: 'checklist', approval_id: approval.approval_id,
          text: `Denied by ${name}:\n${reasons}\nEvery reason is fixable with paperwork. Corrected packet ready. Approve to appeal:`,
          data: { checklist: analysis.checklist, approval_id: approval.approval_id, kind: 'appeal' },
        });
      } else {
        const actions = analysis.unfixable.map((u) => `  · ${u.action}`).join('\n');
        chat(caseId, {
          role: 'agent', kind: 'verdict',
          text: `Denied by ${name}:\n${reasons}\nHonest read: an appeal on paperwork alone won't flip this.\n${actions}\nThe denial is now in the graph; the whole network just learned from it.`,
        });
        await cases.transition(caseId, 'CLOSED', { outcome: 'DENIED' });
      }
    },

    getSession(caseId) { return [...sessions.values()].find((x) => x.case_id === caseId) || null; },
    chatlog(caseId) { return chatlogs.get(caseId) || []; },
    chatPush: chat,
    currentPredictionFor: async (caseId) => {
      const s = [...sessions.values()].find((x) => x.case_id === caseId);
      if (!s) return null;
      return currentPrediction(s);
    },
  };
}

function toPlain(factMap) {
  const out = {};
  for (const [k, v] of Object.entries(factMap || {})) out[k] = v.value;
  return out;
}

// Live-mic diarization. The Web Speech API returns one undifferentiated
// stream, so speakers are tagged from what is said: deterministic keyword
// cues, with turn alternation as the tiebreak. The manual toggle overrides.
const DOCTOR_CUES = /\b(let'?s|we'?ll|i recommend|i'?d like to (order|get|see)|any (numbness|tingling|weakness|fever)|have you (tried|had|been)|how (long|often|severe|bad)|does (it|the pain)|on a scale|physical therapy|we should|i'?m going to|order (an|the)|imaging|mri|follow up|keep up|screening|red flags?|your (chart|results|plan))\b/i;
const PATIENT_CUES = /\b(i (feel|felt|hurt|can'?t|couldn'?t|was hoping|noticed|tried)|my (back|leg|legs|foot|hip|pain|insurance|job)|it (hurts|aches|gets worse|feels)|hurts when|worse (when|at|in)|i'?ve (been|had|got)|will (it|insurance|this)|thanks,? doctor|since (january|february|march|april|may|june|july|august|september|october|november|december|last|mid|early|late)|weeks? ago)\b/i;

export function classifySpeaker(text, last) {
  const d = DOCTOR_CUES.test(text);
  const p = PATIENT_CUES.test(text);
  if (d && !p) return 'doctor';
  if (p && !d) return 'patient';
  if (!last) return 'doctor';                      // doctors open visits
  return last === 'doctor' ? 'patient' : 'doctor'; // conversations alternate
}
