// GROUND TRUTH payer rules (spec §3.1). This module is the ONLY place these
// rules exist. The rest of the app must learn them from streamed outcomes.
// Pure function, no randomness, no LLM — verdicts are perfectly repeatable.

export const REASON = {
  THERAPY_DURATION_INSUFFICIENT: 'THERAPY_DURATION_INSUFFICIENT',
  PT_NOTES_MISSING: 'PT_NOTES_MISSING',
  REDFLAG_SCREEN_MISSING: 'REDFLAG_SCREEN_MISSING',
  ORDER_FORM_MISSING: 'ORDER_FORM_MISSING',
  DIAGNOSIS_CODE_INVALID: 'DIAGNOSIS_CODE_INVALID',
};

/**
 * @param {object} packet {therapy_weeks, pt_notes, redflag_screen, order_form, dx, redflags_present}
 * @param {string} payerId any id in domain/payers.js PAYERS
 * @returns {{outcome:'APPROVED'|'DENIED'|'EXPEDITED', reason_codes:string[], reason_params:object}}
 */
export function verdict(packet, payerId) {
  // All payers: documented red flags (cauda equina, cancer history, fever/weight
  // loss) → expedited auto-approval, no further checks.
  if (packet.redflags_present === true) {
    return { outcome: 'EXPEDITED', reason_codes: [], reason_params: {} };
  }

  const fails = []; // [{code, params}]
  const weeks = Number(packet.therapy_weeks) || 0;

  switch (payerId) {
    case 'bluepeak': {
      if (weeks < 6) fails.push({ code: REASON.THERAPY_DURATION_INSUFFICIENT, params: { required_weeks: 6 } });
      if (!packet.pt_notes) fails.push({ code: REASON.PT_NOTES_MISSING, params: {} });
      if (!packet.redflag_screen) fails.push({ code: REASON.REDFLAG_SCREEN_MISSING, params: {} });
      break;
    }
    case 'meridian': {
      if (weeks < 4) fails.push({ code: REASON.THERAPY_DURATION_INSUFFICIENT, params: { required_weeks: 4 } });
      if (!packet.redflag_screen) fails.push({ code: REASON.REDFLAG_SCREEN_MISSING, params: {} });
      if (!packet.order_form) fails.push({ code: REASON.ORDER_FORM_MISSING, params: {} });
      break;
    }
    case 'calwest': {
      if (packet.dx !== 'M54.5') fails.push({ code: REASON.DIAGNOSIS_CODE_INVALID, params: {} });
      if (weeks < 1) fails.push({ code: REASON.THERAPY_DURATION_INSUFFICIENT, params: { required_weeks: 1 } });
      break;
    }
    case 'atlas': {
      // The strictest conservative-therapy gate on the network.
      if (weeks < 8) fails.push({ code: REASON.THERAPY_DURATION_INSUFFICIENT, params: { required_weeks: 8 } });
      if (!packet.pt_notes) fails.push({ code: REASON.PT_NOTES_MISSING, params: {} });
      if (!packet.order_form) fails.push({ code: REASON.ORDER_FORM_MISSING, params: {} });
      break;
    }
    case 'pinnacle': {
      if (weeks < 2) fails.push({ code: REASON.THERAPY_DURATION_INSUFFICIENT, params: { required_weeks: 2 } });
      if (!packet.redflag_screen) fails.push({ code: REASON.REDFLAG_SCREEN_MISSING, params: {} });
      if (!packet.pt_notes) fails.push({ code: REASON.PT_NOTES_MISSING, params: {} });
      break;
    }
    case 'sequoia': {
      // No therapy-duration gate at all — pure paperwork payer.
      if (packet.dx !== 'M54.5') fails.push({ code: REASON.DIAGNOSIS_CODE_INVALID, params: {} });
      if (!packet.order_form) fails.push({ code: REASON.ORDER_FORM_MISSING, params: {} });
      if (!packet.redflag_screen) fails.push({ code: REASON.REDFLAG_SCREEN_MISSING, params: {} });
      break;
    }
    default:
      throw new Error(`unknown payer: ${payerId}`);
  }

  if (fails.length === 0) return { outcome: 'APPROVED', reason_codes: [], reason_params: {} };
  const reason_params = {};
  for (const f of fails) reason_params[f.code] = f.params;
  return { outcome: 'DENIED', reason_codes: fails.map((f) => f.code), reason_params };
}
