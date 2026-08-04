// Parser: Blue Shield of California Promise Health Plan (Medi-Cal) prior
// authorization list. Deterministic. Row shape is "CODE Description" one per
// line, with wrapped description continuations on following lines. The list
// names specialized imaging codes explicitly (functional/fetal/cardiac MRI)
// and carries no blanket radiology delegation — absence of a routine imaging
// code on this list is the document's own statement.
const LEAD_CODE = /^(\d{5}|\d{4}[A-Z]|[A-Z]\d{4})\b\s*(.*)$/;
const NOISE = [
  /^\d+\s*\/\s*\d+/,               // "12 / 51" page markers
  /^blueshieldca\.com/i,
  /^Blue Shield of California Promise/i,
  /^Medi-Cal$/i,
  /^Prior Authorization List$/i,
  /^Updated\s+/i,
  /^This .* list is the latest update/i,
  /^Changes made to the list include/i,
  /^•/,
  /^TBSP\d+/i,
];

function months() {
  return ['january', 'february', 'march', 'april', 'may', 'june', 'july',
    'august', 'september', 'october', 'november', 'december'];
}

export function bspEffectiveDate(text) {
  const m = text.match(/Updated\s+([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/);
  if (!m) return null;
  const mi = months().indexOf(m[1].toLowerCase());
  if (mi < 0) return null;
  return `${m[3]}-${String(mi + 1).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
}

export function parseBspList(text, { source, sha256, fetched_at } = {}) {
  const effective_from = bspEffectiveDate(text);
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
    .filter((l) => !NOISE.some((re) => re.test(l)));

  const rules = [];
  let last = null;
  for (const line of lines) {
    const m = line.match(LEAD_CODE);
    if (m) {
      last = { kind: 'code', requirement: 'prior_auth', policy: m[2].trim() || m[1], codes: [m[1]] };
      rules.push(last);
    } else if (last && last.policy.length < 200 && /[a-z]/.test(line)) {
      // wrapped description continuation
      last.policy = `${last.policy} ${line}`.slice(0, 240);
    }
  }

  return {
    source_id: source?.id || 'blueshield-promise-pa-list',
    payer_id: source?.payer_id || 'blueshield_ca',
    payer_name: source?.payer_name || 'Blue Shield of California Promise Health Plan',
    lob: source?.lob || 'medi-cal',
    document: {
      title: 'Blue Shield Promise Medi-Cal Prior Authorization List',
      url: source?.url || null,
    },
    effective_from,
    sha256: sha256 || null,
    fetched_at: fetched_at || null,
    rules,
    changelog: { added: [], removed: [] },
    stats: {
      code_rules: rules.length,
      category_rules: 0,
      distinct_codes: new Set(rules.flatMap((r) => r.codes)).size,
    },
  };
}
