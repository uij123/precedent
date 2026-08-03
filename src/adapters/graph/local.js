// In-memory graph twin — emergency fallback behind the FalkorDB adapter.
// Implements the same GraphStore contract with identical learning semantics
// (both call the pure rule in core/learn.js).
import { applyOutcome } from '../../core/learn.js';
import { PAYERS } from '../../domain/payers.js';

export function createLocalGraph() {
  const state = freshState();

  function freshState() {
    return {
      patients: new Map(),
      consults: new Map(), // id -> {consult_id, patient_id, started_at, facts: []}
      requirements: new Map(Object.keys(PAYERS).map((p) => [p, new Map()])), // payer -> code -> req
      evidence: new Map(), // `${payer}:${code}` -> [{src_kind, src_id, clinic_id, outcome, ts, therapy_weeks}]
      submissions: new Map(),
      networkEventCount: 0,
    };
  }

  function pushEvidence(payerId, code, item) {
    const key = `${payerId}:${code}`;
    if (!state.evidence.has(key)) state.evidence.set(key, []);
    const arr = state.evidence.get(key);
    arr.push(item);
    if (arr.length > 25) arr.shift();
  }

  return {
    mode: 'local',
    async init() {},
    async close() {},
    async resetAll() { Object.assign(state, freshState()); },

    async ensurePatient(p) { state.patients.set(p.id, { ...p }); },
    async getPatient(id) { return state.patients.get(id) || null; },
    async addUtterance(consultId, u) {
      const c = state.consults.get(consultId);
      if (c) (c.utterances ||= []).push({ consult_id: consultId, seq: u.seq || 0, speaker: u.speaker, text: u.text, ts: u.ts });
    },
    async getUtterances(consultId) {
      return [...(state.consults.get(consultId)?.utterances || [])]
        .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.seq - b.seq));
    },
    async listConsults(limit = 30) {
      return [...state.consults.values()]
        .sort((a, b) => (a.started_at < b.started_at ? 1 : -1)).slice(0, limit)
        .map((c) => ({
          consult_id: c.consult_id, started_at: c.started_at,
          patient_name: state.patients.get(c.patient_id)?.name || c.patient_id,
          payer_id: state.patients.get(c.patient_id)?.payer_id || null,
        }));
    },
    async ensureConsult(c) {
      if (!state.consults.has(c.consult_id)) state.consults.set(c.consult_id, { ...c, facts: [] });
    },
    async addFact(consultId, fact) {
      const c = state.consults.get(consultId);
      if (c) c.facts.push({ ...fact });
    },
    async getFacts(consultId) {
      const c = state.consults.get(consultId);
      const out = {};
      for (const f of c?.facts || []) out[f.type] = { value: f.value, seq: f.seq }; // latest wins
      return out;
    },

    async learnFromOutcome(evt) {
      const reqs = state.requirements.get(evt.payer_id);
      if (!reqs) return [];
      const changed = applyOutcome(reqs, evt);
      for (const r of changed) {
        reqs.set(r.code, r);
        pushEvidence(evt.payer_id, r.code, {
          src_kind: evt.kind, src_id: evt.source_id, clinic_id: evt.clinic_id || null,
          outcome: evt.outcome, ts: evt.ts, therapy_weeks: evt.packet?.therapy_weeks ?? null,
        });
      }
      if (evt.kind === 'network') state.networkEventCount += 1;
      if (evt.kind === 'submission') {
        const s = state.submissions.get(evt.source_id);
        if (s) s.outcome = { outcome: evt.outcome, reason_codes: evt.reason_codes, ts: evt.ts };
      }
      return changed.map((r) => r.code);
    },

    async getRequirements(payerId) {
      return [...(state.requirements.get(payerId)?.values() || [])].map((r) => ({ ...r }));
    },
    async getRequirementEvidence(payerId, code, limit = 5) {
      return (state.evidence.get(`${payerId}:${code}`) || []).slice(-limit).reverse();
    },

    async createSubmission(s) { state.submissions.set(s.submission_id, { ...s, costs: null, state: null }); },
    async setSubmissionState(id, st) { const s = state.submissions.get(id); if (s) s.state = st; },
    async setSubmissionCost(id, costs) { const s = state.submissions.get(id); if (s) s.costs = { ...costs }; },
    async getSubmission(id) { return state.submissions.get(id) || null; },

    async multiHopEvidence(patientId) {
      const p = state.patients.get(patientId);
      if (!p) return { payer_id: null, requirements: [] };
      const reqs = await this.getRequirements(p.payer_id);
      const requirements = [];
      for (const r of reqs) {
        requirements.push({ ...r, evidence: await this.getRequirementEvidence(p.payer_id, r.code, 5) });
      }
      return { payer_id: p.payer_id, requirements };
    },

    async rulebook() {
      const out = [];
      for (const [payerId, reqs] of state.requirements) {
        out.push({
          payer_id: payerId, name: PAYERS[payerId].name,
          requirements: [...reqs.values()].map((r) => ({ ...r })),
        });
      }
      return out;
    },

    async counts() {
      let facts = 0;
      for (const c of state.consults.values()) facts += c.facts.length;
      const reqCount = [...state.requirements.values()].reduce((a, m) => a + m.size, 0);
      const nodes = state.patients.size + state.consults.size + facts + reqCount
        + state.submissions.size + state.networkEventCount + Object.keys(PAYERS).length + 6;
      return { nodes, edges: facts + reqCount * 2 + state.submissions.size * 2 + state.networkEventCount, facts, requirements: reqCount, network_events: state.networkEventCount };
    },
  };
}
