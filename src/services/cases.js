// Case lifecycle (spec §11A): every PA case is a tracked process with an
// explicit state machine. Transitions are events, published to the
// case.lifecycle LaserData topic; the manager console is derived from that
// stream. Current state is also persisted on the Submission node in the graph.
import { nowIso } from '../util.js';

export const STATES = [
  'CONSULT', 'PREDICTED', 'AWAITING_HUMAN_APPROVAL', 'EXECUTING',
  'SUBMITTED', 'AWAITING_PAYER', 'VERDICT_RECEIVED', 'APPEALING', 'CLOSED',
];

// Who the case is waiting on in each state — the stuck-attribution tags.
// CONSULT and PREDICTED wait on people (the visit itself, then the clinician
// deciding to submit). Agents only hold a case during transient execution
// states measured in milliseconds — by design they are never a resting
// bottleneck.
export const BLOCKING = {
  CONSULT: 'HUMAN',
  PREDICTED: 'HUMAN',
  AWAITING_HUMAN_APPROVAL: 'HUMAN',
  EXECUTING: 'AGENT',
  SUBMITTED: 'AGENT',
  AWAITING_PAYER: 'PAYER',
  VERDICT_RECEIVED: 'AGENT',
  APPEALING: 'AGENT',
  CLOSED: null,
};

export function createCases({ bus, graph }) {
  const cases = new Map(); // case_id -> case

  async function emit(c, meta = {}) {
    const event = {
      case_id: c.case_id,
      consult_id: c.consult_id,
      patient: c.patient,
      payer_id: c.payer_id,
      state: c.state,
      blocking: BLOCKING[c.state],
      attempt: c.attempt,
      ts: nowIso(),
      meta,
    };
    await bus.publish('case.lifecycle', event);
    if (c.submission_id) await graph.setSubmissionState(c.submission_id, c.state);
  }

  return {
    async open({ case_id, consult_id, patient, payer_id, cpt }) {
      const c = {
        case_id, consult_id, patient, payer_id, cpt: cpt || '72148',
        state: 'CONSULT', attempt: 1, submission_id: null,
        opened_at: nowIso(),
        history: [{ state: 'CONSULT', at: Date.now() }],
        outcome: null,
      };
      cases.set(case_id, c);
      await emit(c);
      return c;
    },

    async transition(caseId, state, meta = {}) {
      const c = cases.get(caseId);
      if (!c) throw new Error(`unknown case ${caseId}`);
      if (!STATES.includes(state)) throw new Error(`unknown state ${state}`);
      if (c.state === state) return c;
      c.state = state;
      c.history.push({ state, at: Date.now(), ...('note' in meta ? { note: meta.note } : {}) });
      if (meta.submission_id) c.submission_id = meta.submission_id;
      if (meta.attempt) c.attempt = meta.attempt;
      if (meta.outcome) c.outcome = meta.outcome;
      await emit(c, meta);
      return c;
    },

    get: (caseId) => cases.get(caseId) || null,
    all: () => [...cases.values()],

    /** Per-case durations by blocking party + snapshot for the console. */
    snapshot({ agingAmberMs, agingRedMs }) {
      const now = Date.now();
      const byParty = { HUMAN: 0, AGENT: 0, PAYER: 0 };
      const list = [...cases.values()].map((c) => {
        const perParty = { HUMAN: 0, AGENT: 0, PAYER: 0 };
        for (let i = 0; i < c.history.length; i++) {
          const seg = c.history[i];
          const end = i + 1 < c.history.length ? c.history[i + 1].at : now;
          const party = BLOCKING[seg.state];
          if (party) perParty[party] += end - seg.at;
        }
        for (const p of Object.keys(byParty)) byParty[p] += perParty[p];
        const inStateMs = now - c.history[c.history.length - 1].at;
        const aging = c.state === 'CLOSED' ? 'done'
          : inStateMs > agingRedMs ? 'red' : inStateMs > agingAmberMs ? 'amber' : 'green';
        return {
          case_id: c.case_id, consult_id: c.consult_id, patient: c.patient, payer_id: c.payer_id,
          cpt: c.cpt || '72148',
          state: c.state, blocking: BLOCKING[c.state], attempt: c.attempt, outcome: c.outcome,
          in_state_ms: inStateMs, aging, per_party_ms: perParty, opened_at: c.opened_at,
          timeline: c.history.map((h) => ({ state: h.state, at: new Date(h.at).toISOString(), note: h.note })),
        };
      });
      const total = byParty.HUMAN + byParty.AGENT + byParty.PAYER || 1;
      return {
        cases: list,
        attribution: {
          HUMAN: { ms: byParty.HUMAN, pct: Math.round((byParty.HUMAN / total) * 100) },
          AGENT: { ms: byParty.AGENT, pct: Math.round((byParty.AGENT / total) * 100) },
          PAYER: { ms: byParty.PAYER, pct: Math.round((byParty.PAYER / total) * 100) },
        },
        alerts: list.filter((c) => c.state === 'AWAITING_HUMAN_APPROVAL' && c.aging === 'red')
          .map((c) => ({ case_id: c.case_id, patient: c.patient, waiting_ms: c.in_state_ms })),
      };
    },
  };
}
