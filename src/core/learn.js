// The learning rule (spec §5) — PLAIN CODE, deliberately not an LLM.
// On any DENIED event with reason code R for payer P: merge Requirement{code:R},
// increment evidence_count, confidence = min(1, evidence_count / 3), absorb
// params carried by the denial (e.g. required_weeks). On APPROVED events,
// requirements *satisfied by that packet* also gain confidence. Therapy-week
// observations additionally record bounds (denied_at_max / approved_at_min) so
// the app can be honest about untested gaps ("denied at 4w, approved at 6w,
// 5w untested").

export const THERAPY = 'THERAPY_DURATION_INSUFFICIENT';

/** Quantized so values survive any backend's float round-trip byte-identically. */
export function confidenceFor(evidenceCount) {
  return Math.round(Math.min(1, evidenceCount / 3) * 10000) / 10000;
}

export function emptyRequirement(code) {
  return {
    code,
    params: {},
    evidence_count: 0,
    confidence: 0,
    denied_at_max: null,
    approved_at_min: null,
    last_seen: null,
  };
}

/** Does this packet satisfy a learned requirement? Deterministic. */
export function packetSatisfies(req, packet) {
  const weeks = Number(packet.therapy_weeks) || 0;
  switch (req.code) {
    case THERAPY: {
      if (Number.isFinite(req.params.required_weeks)) return weeks >= req.params.required_weeks;
      if (Number.isFinite(req.approved_at_min)) return weeks >= req.approved_at_min;
      return false; // threshold unknown → cannot confirm satisfied
    }
    case 'PT_NOTES_MISSING': return !!packet.pt_notes;
    case 'REDFLAG_SCREEN_MISSING': return !!packet.redflag_screen;
    case 'ORDER_FORM_MISSING': return !!packet.order_form;
    case 'DIAGNOSIS_CODE_INVALID': return packet.dx === 'M54.5';
    default: return false;
  }
}

/**
 * Apply one outcome event to a payer's current requirement map.
 * @param {Map<string,object>} existing code -> requirement (NOT mutated)
 * @param {object} evt {payer_id, packet, outcome, reason_codes, reason_params, ts}
 * @returns {Array<object>} updated requirement objects (only the changed ones)
 */
export function applyOutcome(existing, evt) {
  const changed = [];
  const weeks = Number(evt.packet?.therapy_weeks) || 0;

  if (evt.outcome === 'DENIED') {
    for (const code of evt.reason_codes || []) {
      const prev = existing.get(code) || emptyRequirement(code);
      const next = { ...prev, params: { ...prev.params, ...(evt.reason_params?.[code] || {}) } };
      next.evidence_count = prev.evidence_count + 1;
      next.confidence = confidenceFor(next.evidence_count);
      next.last_seen = evt.ts;
      if (code === THERAPY) {
        next.denied_at_max = prev.denied_at_max === null ? weeks : Math.max(prev.denied_at_max, weeks);
      }
      changed.push(next);
    }
  } else if (evt.outcome === 'APPROVED') {
    for (const prev of existing.values()) {
      if (!packetSatisfies(prev, evt.packet)) continue;
      const next = { ...prev };
      next.evidence_count = prev.evidence_count + 1;
      next.confidence = confidenceFor(next.evidence_count);
      next.last_seen = evt.ts;
      if (prev.code === THERAPY) {
        next.approved_at_min = prev.approved_at_min === null ? weeks : Math.min(prev.approved_at_min, weeks);
      }
      changed.push(next);
    }
  }
  // EXPEDITED: clinical red-flag pathway — carries no payer-rule information.
  return changed;
}
