// The deterministic resolver: one pure function from (rulesets, question) to
// an answer that carries its own derivation. No I/O, no clock, no LLM, no
// randomness — same inputs, same output, every time. Precedence is explicit:
// exact code rule > curated delegated category > "not on the list". UNKNOWN
// exists only for questions the ingested data cannot answer, and it always
// says why.
import { codeInCategory, CATEGORY_CODE_MAP } from './categories.js';

const CODE_RE = /^(?:\d{5}|\d{4}[A-Z]|[A-Z]\d{4})$/;

export function normalizeCode(code) {
  return String(code || '').toUpperCase().trim();
}

/**
 * @param {Array} rulesets canonical ruleset objects (any payers/lobs/versions)
 * @param {{payer:string, lob:string, code:string, asOf:string}} q asOf: YYYY-MM-DD
 */
export function resolve(rulesets, q) {
  const code = normalizeCode(q.code);
  const asOf = q.asOf;
  const derivation = [];

  if (!CODE_RE.test(code)) {
    return unknown('invalid_code', `"${q.code}" is not a CPT or HCPCS code shape.`, q, derivation);
  }

  // Pick the ruleset for this payer+line effective at asOf: the newest
  // effective_from that is <= asOf. Stable sort keeps this deterministic.
  const candidates = rulesets
    .filter((r) => r.payer_id === q.payer && r.lob === q.lob && r.effective_from && r.effective_from <= asOf)
    .sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1));
  if (!candidates.length) {
    const anyPayer = rulesets.some((r) => r.payer_id === q.payer);
    return unknown(
      anyPayer ? 'line_not_ingested' : 'payer_not_ingested',
      anyPayer
        ? `No ${q.lob} list ingested for ${q.payer} effective on or before ${asOf}.`
        : `No lists ingested for payer "${q.payer}".`,
      q, derivation,
    );
  }
  const rs = candidates[0];
  derivation.push({
    step: 'ruleset_selected',
    detail: `${rs.payer_name} · ${rs.lob} list effective ${rs.effective_from} (snapshot ${short(rs.sha256)}).`,
  });

  // 1. Exact code rules (highest precedence). A code may sit in several
  //    policies; all are returned, sorted for stability.
  const codeHits = rs.rules
    .filter((r) => r.kind === 'code' && r.codes.includes(code))
    .sort((a, b) => (a.policy < b.policy ? -1 : 1));
  if (codeHits.length) {
    derivation.push({
      step: 'explicit_code_match',
      detail: `Code ${code} listed under: ${codeHits.map((r) => r.policy).join('; ')}.`,
    });
    return answer('prior_auth', q, rs, derivation, {
      policies: codeHits.map((r) => r.policy),
      detail: 'Prior authorization required. The code appears explicitly on the payer list.',
    });
  }
  derivation.push({ step: 'explicit_code_match', detail: `Code ${code} not listed explicitly.` });

  // 2. Delegated categories via curated mapping.
  const catRules = rs.rules
    .filter((r) => r.kind === 'category')
    .sort((a, b) => (a.category_key < b.category_key ? -1 : 1));
  for (const r of catRules) {
    if (codeInCategory(code, r.category_key)) {
      derivation.push({
        step: 'category_match_curated',
        detail: `Code ${code} falls in "${CATEGORY_CODE_MAP[r.category_key].label}" per Precedent's curated range map (the payer document names the program without codes; the delegate's own list is a pending source).`,
      });
      return answer('prior_auth_delegated', q, rs, derivation, {
        policies: [r.policy],
        delegate: r.delegate,
        detail: `Prior authorization required, managed by the delegate (${r.delegate}), not the payer's own portal.`,
      });
    }
  }
  const unmapped = catRules.filter((r) => !CATEGORY_CODE_MAP[r.category_key]?.curated);
  if (unmapped.length) {
    derivation.push({
      step: 'unmapped_delegates_note',
      detail: `Delegated programs without curated code maps exist (${unmapped.map((r) => r.policy).join('; ')}); if this code belongs to one of them, this answer will change when the delegate list is ingested.`,
    });
  }

  // 3. Not on the list — which is itself the answer, per this document.
  derivation.push({
    step: 'not_listed',
    detail: `Code ${code} is absent from the list effective ${rs.effective_from}.`,
  });
  return answer('no_prior_auth_listed', q, rs, derivation, {
    policies: [],
    detail: 'No prior authorization appears for this code on the payer\'s list in force.',
  });
}

function answer(requirement_type, q, rs, derivation, extra) {
  return {
    requirement_type,
    payer: rs.payer_id,
    payer_name: rs.payer_name,
    lob: rs.lob,
    code: normalizeCode(q.code),
    as_of: q.asOf,
    ...extra,
    source: {
      document: rs.document,
      effective_from: rs.effective_from,
      sha256: rs.sha256,
      fetched_at: rs.fetched_at,
    },
    derivation,
  };
}

function unknown(reason, detail, q, derivation) {
  derivation.push({ step: 'unknown', detail });
  return {
    requirement_type: 'unknown',
    reason,
    payer: q.payer, lob: q.lob, code: normalizeCode(q.code), as_of: q.asOf,
    detail,
    derivation,
  };
}

function short(sha) { return sha ? sha.slice(0, 12) : 'unsnapshotted'; }
