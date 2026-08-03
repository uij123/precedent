// The deterministic decision core (spec §8). PLAIN CODE — no LLM anywhere.
// predict() compares learned payer Requirements against consult Facts and
// returns the same answer for the same inputs, every run. LLM agents explain
// and argue ON TOP of this output; they never change it.
//
// One piece of a-priori knowledge is allowed and clearly scoped: the CLINICAL
// red-flag pathway (cauda equina etc. → urgent imaging) is medicine, not a
// payer quirk, so it does not need to be learned from denials.
import { THERAPY, confidenceFor } from './learn.js';
import { payerName } from '../domain/payers.js';
import { DIAGNOSIS } from '../domain/payers.js';

export const REQ_LABELS = {
  THERAPY_DURATION_INSUFFICIENT: 'Documented conservative therapy duration',
  PT_NOTES_MISSING: 'PT provider notes attached (PDF)',
  REDFLAG_SCREEN_MISSING: 'Red-flag screening documented',
  ORDER_FORM_MISSING: 'Imaging order form attached',
  DIAGNOSIS_CODE_INVALID: `Valid diagnosis code (${DIAGNOSIS.code})`,
};

// A-priori clinical grounding, cited in the sources panel. Everything else in
// the rulebook is learned from outcomes and has no document to cite — the
// observed events ARE the source.
export const CLINICAL_STANDARDS = {
  REDFLAG_SCREEN_MISSING: 'Red-flag screening before lumbar imaging follows the ACR low-back-pain appropriateness guideline; it is medicine, not a payer quirk.',
  DIAGNOSIS_CODE_INVALID: `Coding the documented diagnosis (${DIAGNOSIS.code}, ${DIAGNOSIS.label}) is standard claims practice.`,
  ORDER_FORM_MISSING: 'A signed imaging order form is standard claims paperwork, assembled automatically by the packet builder.',
};

// Requirements the clinic can always satisfy by assembling paperwork correctly
// (vs. facts that must be true about the patient).
const AUTO_FIXABLE = new Set(['ORDER_FORM_MISSING', 'DIAGNOSIS_CODE_INVALID']);

/**
 * @param {object} args
 * @param {string} args.payerId
 * @param {object} args.facts   plain values: {therapy_weeks?, pt_notes_available?, redflags?, imaging_intent?}
 * @param {Array}  args.requirements  learned reqs for this payer (may carry .evidence arrays)
 * @returns {{prediction, confidence, missing, items, evidence, narrative}}
 */
export function predict({ payerId, facts, requirements }) {
  const name = payerName(payerId);

  // Clinical red-flag pathway — deterministic, a-priori clinical guideline.
  if (facts.redflags === 'present') {
    return {
      prediction: 'LIKELY_EXPEDITED',
      confidence: 1,
      missing: [],
      items: [],
      evidence: [],
      narrative: 'Documented red flags (cauda equina symptoms) — clinical urgent-imaging pathway. Payers expedite when red flags are documented in the packet.',
    };
  }

  const learned = (requirements || []).filter((r) => r.evidence_count > 0);
  if (learned.length === 0) {
    return {
      prediction: 'UNKNOWN',
      confidence: 0,
      missing: [],
      items: [],
      evidence: [],
      narrative: `Insufficient memory — no precedents observed for ${name} yet. The graph learns from every verdict on the network; check back once events arrive.`,
    };
  }

  const items = learned
    .map((r) => classify(r, facts))
    .sort((a, b) => (a.code < b.code ? -1 : 1)); // stable output order
  const unmet = items.filter((i) => i.status === 'unmet');
  const unknown = items.filter((i) => i.status === 'unknown');

  let prediction;
  if (unmet.length > 0) prediction = 'LIKELY_DENIED';
  else if (unknown.length > 0) prediction = 'UNKNOWN';
  else prediction = 'LIKELY_APPROVED';

  // Confidence = how well-evidenced the requirements driving the answer are:
  // the unmet ones for a denial call, the undecidable ones for UNKNOWN, all of
  // them for an approval call.
  const driving = prediction === 'LIKELY_DENIED' ? unmet : prediction === 'UNKNOWN' ? unknown : items;
  const confidence = driving.length
    ? Math.min(...driving.map((i) => confidenceFor(i.evidence_count)))
    : 0;

  const evidence = [];
  for (const i of items) for (const e of i.evidence || []) evidence.push({ ...e, code: i.code });

  return {
    prediction,
    confidence,
    missing: [...unmet, ...unknown],
    items,
    evidence,
    narrative: narrativeFor(prediction, name, unmet, unknown, items),
  };
}

function classify(r, facts) {
  const base = {
    code: r.code,
    label: REQ_LABELS[r.code] || r.code,
    params: r.params || {},
    evidence_count: r.evidence_count,
    req_confidence: r.confidence,
    evidence: (r.evidence || []).slice(0, 5),
    denied_at_max: r.denied_at_max ?? null,
    approved_at_min: r.approved_at_min ?? null,
  };

  if (AUTO_FIXABLE.has(r.code)) {
    return { ...base, status: 'auto', detail: 'Assembled automatically by the packet builder.', action: null };
  }

  switch (r.code) {
    case THERAPY: {
      const weeks = facts.therapy_weeks;
      const required = Number.isFinite(r.params?.required_weeks) ? r.params.required_weeks : null;
      if (weeks === undefined || weeks === null) {
        return { ...base, status: 'unknown', detail: 'Therapy duration not documented in this consult.', action: 'Document conservative-therapy duration.' };
      }
      if (required !== null) {
        if (weeks >= required) return { ...base, status: 'met', detail: `${weeks} weeks documented; ${required} required.`, action: null };
        return {
          ...base, status: 'unmet',
          detail: `${weeks} weeks documented; this payer requires ${required}.`,
          action: `Wait ${required - weeks} more week${required - weeks === 1 ? '' : 's'} of documented therapy (or appeal with additional history).`,
          gap_weeks: required - weeks,
        };
      }
      // Threshold never revealed in a denial yet — reason from observed bounds.
      if (base.approved_at_min !== null && weeks >= base.approved_at_min) {
        return { ...base, status: 'met', detail: `${weeks} weeks documented; approvals observed at ${base.approved_at_min}+.`, action: null };
      }
      if (base.denied_at_max !== null && weeks <= base.denied_at_max) {
        return { ...base, status: 'unmet', detail: `${weeks} weeks documented; denials observed at ≤${base.denied_at_max}.`, action: 'Extend documented therapy before submitting.' };
      }
      return {
        ...base, status: 'unknown',
        detail: `${weeks} weeks sits in an untested band (denied at ≤${base.denied_at_max ?? '?'} , approved at ≥${base.approved_at_min ?? '?'}).`,
        action: 'Submit to test the band, or wait for a safer margin.',
      };
    }
    case 'PT_NOTES_MISSING': {
      if (facts.pt_notes_available === true) {
        return { ...base, status: 'met', detail: 'PT provider notes available — will be attached.', action: null };
      }
      return { ...base, status: 'unmet', detail: 'No PT provider notes on file for this patient.', action: 'Request session notes from the PT provider.' };
    }
    case 'REDFLAG_SCREEN_MISSING': {
      if (facts.redflags === 'absent' || facts.redflags === 'present') {
        return { ...base, status: 'met', detail: 'Red-flag screening performed and documented this consult.', action: null };
      }
      return { ...base, status: 'unmet', detail: 'Red flags were not screened in this consult.', action: 'Run the red-flag screening questions before ordering.' };
    }
    default:
      return { ...base, status: 'unknown', detail: 'Unrecognized requirement.', action: null };
  }
}

function narrativeFor(prediction, name, unmet, unknown, items) {
  if (prediction === 'LIKELY_DENIED') {
    return `${name} is expected to deny: ${unmet.map((i) => i.label.toLowerCase()).join('; ')}.`;
  }
  if (prediction === 'UNKNOWN') {
    return `Not enough to call it for ${name}: ${unknown.map((i) => i.detail).join(' ')}`;
  }
  return `All ${items.length} learned ${name} requirement${items.length === 1 ? '' : 's'} satisfied — approval expected on first pass.`;
}

/**
 * The to-do list posted to chat for human approval (spec §7): exactly what the
 * packet will claim and attach, each item mapped to why it is included.
 */
export function buildChecklist({ payerId, facts, requirements }) {
  const learned = new Map((requirements || []).filter((r) => r.evidence_count > 0).map((r) => [r.code, r]));
  const items = [];

  items.push({
    key: 'dx', kind: 'field', label: `Diagnosis code ${DIAGNOSIS.code} (${DIAGNOSIS.label})`,
    included: true, reason: 'clinical-standard', satisfied: true,
  });
  items.push({
    key: 'therapy', kind: 'field',
    label: facts.therapy_weeks !== undefined
      ? `Conservative therapy summary — ${facts.therapy_weeks} week${facts.therapy_weeks === 1 ? '' : 's'} documented`
      : 'Conservative therapy summary — duration not documented',
    included: facts.therapy_weeks !== undefined,
    reason: 'clinical-standard', satisfied: facts.therapy_weeks !== undefined,
  });
  const screened = facts.redflags === 'absent' || facts.redflags === 'present';
  items.push({
    key: 'redflag_screen', kind: 'field',
    label: screened
      ? `Red-flag screening — documented (${facts.redflags})`
      : 'Red-flag screening — not performed this consult',
    included: screened, reason: learned.has('REDFLAG_SCREEN_MISSING') ? 'learned-requirement' : 'clinical-standard',
    requirement_code: learned.has('REDFLAG_SCREEN_MISSING') ? 'REDFLAG_SCREEN_MISSING' : undefined,
    satisfied: screened,
  });

  // Attachments are included only when THIS payer is known to demand them —
  // that is the visible learning: the checklist changes because of a denial.
  if (learned.has('PT_NOTES_MISSING')) {
    const ok = facts.pt_notes_available === true;
    items.push({
      key: 'pt_notes', kind: 'attachment',
      label: ok ? 'PT provider session notes (PDF) — attached' : 'PT provider session notes — not available',
      included: ok, reason: 'learned-requirement', requirement_code: 'PT_NOTES_MISSING', satisfied: ok,
    });
  }
  if (learned.has('ORDER_FORM_MISSING')) {
    items.push({
      key: 'order_form', kind: 'attachment', label: 'Imaging order form (PDF) — attached',
      included: true, reason: 'learned-requirement', requirement_code: 'ORDER_FORM_MISSING', satisfied: true,
    });
  }
  if (facts.redflags === 'present') {
    items.push({
      key: 'redflags_present', kind: 'field', label: 'Urgent — documented red flags (expedited pathway)',
      included: true, reason: 'clinical-standard', satisfied: true,
    });
  }
  return items;
}

/** Deterministic packet assembly from facts + checklist (what actually gets submitted). */
export function packetFromChecklist(facts, checklist) {
  const has = (key) => checklist.some((i) => i.key === key && i.included);
  return {
    therapy_weeks: facts.therapy_weeks ?? 0,
    pt_notes: has('pt_notes'),
    redflag_screen: has('redflag_screen'),
    order_form: has('order_form'),
    dx: has('dx') ? DIAGNOSIS.code : null,
    redflags_present: facts.redflags === 'present',
  };
}

/** What-if: recompute the prediction under a hypothetical fact change (chat Q&A). */
export function whatIf({ payerId, facts, requirements, delta }) {
  return predict({ payerId, facts: { ...facts, ...delta }, requirements });
}
