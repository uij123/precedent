// Parser: UnitedHealthcare commercial "Prior authorization requirements"
// (national list; applies to CA commercial). Deterministic text extraction.
// Row shape after PDF flattening: category lines → description lines →
// "Prior authorization required…" marker → a grid of codes (4 per line).
// Codes are exact; policy labels are the block's leading line(s) — best
// effort by design, and said so here. Diagnosis-limited footnotes (*) are
// skipped; asterisks on codes are stripped. The Radiology block delegates to
// UHC's own radiology program with no codes — modeled as a delegated
// category, resolved through the curated advanced-imaging map.
const CODE_RE = /^(?:\d{5}|\d{4}[A-Z]|[A-Z]\d{4})\*?$/;

const MARKER = /^(Prior authorization|Notification\/prior authorization)/i;
const NOISE = [
  /^PCA-\d/i,
  /^CPT\b/,
  /^®/,
  /is a registered trademark/i,
  /^Effective\s+/i,
  /^General information$/i,
  /^Prior authorization requirements$/i,
  /^for UnitedHealthcare commercial plans$/i,
];

function months() {
  return ['january', 'february', 'march', 'april', 'may', 'june', 'july',
    'august', 'september', 'october', 'november', 'december'];
}

export function uhcEffectiveDate(text) {
  const m = text.match(/Effective\s+([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/);
  if (!m) return null;
  const mi = months().indexOf(m[1].toLowerCase());
  if (mi < 0) return null;
  return `${m[3]}-${String(mi + 1).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
}

export function parseUhcList(text, { source, sha256, fetched_at } = {}) {
  const effective_from = uhcEffectiveDate(text);
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
    .filter((l) => !NOISE.some((re) => re.test(l)));

  const rules = [];
  let nameBuf = [];
  let sawMarker = false;
  let codes = [];
  let skippingFootnote = false;

  const label = () => {
    const a = nameBuf[0] || 'Unlabeled section';
    const b = nameBuf[1] && nameBuf[1].length <= 40 ? ` ${nameBuf[1]}` : '';
    return `${a}${b}`.replace(/\s+/g, ' ').trim();
  };

  const flush = () => {
    if (codes.length) {
      rules.push({ kind: 'code', requirement: 'prior_auth', policy: label(), codes: [...new Set(codes)] });
    } else if (sawMarker && /^Radiology\b/i.test(nameBuf[0] || '')) {
      rules.push({
        kind: 'category', requirement: 'prior_auth_delegated',
        policy: 'Radiology (advanced imaging)',
        delegate: 'UnitedHealthcare Radiology Prior Authorization program',
        category_key: 'advanced_imaging',
      });
    }
    nameBuf = []; codes = []; sawMarker = false;
  };

  for (const line of lines) {
    // dx-limited footnotes: "*Notification/prior authorization required for
    // the following diagnosis codes: E66.01, …" possibly wrapping
    if (/^\*/.test(line)) { skippingFootnote = true; continue; }
    if (skippingFootnote) {
      if (/^codes?:/i.test(line) || /\d{2}\.\d/.test(line) || /^Z\d{2}/.test(line)) continue;
      skippingFootnote = false;
    }

    const tokens = line.split(/[\s,]+/).filter(Boolean);
    const codeTokens = tokens.filter((t) => CODE_RE.test(t));
    const allCodes = tokens.length > 0 && codeTokens.length === tokens.length;

    if (allCodes) { codes.push(...codeTokens.map((t) => t.replace(/\*$/, ''))); continue; }
    if (MARKER.test(line)) { sawMarker = true; continue; }
    // prose after the marker (portal instructions etc.) is skipped until codes
    if (sawMarker && !codes.length) {
      if (!/^[A-Z]/.test(line) || /please|visit|call|portal|network|coverage|specific/i.test(line)) continue;
      // a fresh capitalized heading ends a codeless block (e.g. Radiology)
      flush();
      nameBuf.push(line);
      continue;
    }
    if (codes.length) { flush(); nameBuf.push(line); continue; }
    nameBuf.push(line);
  }
  flush();

  // Radiology delegation is stated in prose, not as a code table; detect it
  // at document level so the flattened layout cannot hide it.
  if (/Radiology Prior Authorization and Notification/i.test(text)
    && !rules.some((r) => r.kind === 'category' && r.category_key === 'advanced_imaging')) {
    rules.push({
      kind: 'category', requirement: 'prior_auth_delegated',
      policy: 'Radiology (advanced imaging)',
      delegate: 'UnitedHealthcare Radiology Prior Authorization program',
      category_key: 'advanced_imaging',
    });
  }

  return {
    source_id: source?.id || 'uhc-commercial-pa-list',
    payer_id: source?.payer_id || 'uhc_ca',
    payer_name: source?.payer_name || 'UnitedHealthcare',
    lob: source?.lob || 'commercial',
    document: {
      title: 'Prior authorization requirements for UnitedHealthcare commercial plans',
      url: source?.url || null,
      note: 'National commercial list; applies to California commercial plans. Codes are exact; policy labels are approximate pending a column-aware parser.',
    },
    label_quality: 'approximate',
    effective_from,
    sha256: sha256 || null,
    fetched_at: fetched_at || null,
    rules,
    changelog: { added: [], removed: [] },
    stats: {
      code_rules: rules.filter((r) => r.kind === 'code').length,
      category_rules: rules.filter((r) => r.kind === 'category').length,
      distinct_codes: new Set(rules.flatMap((r) => r.codes || [])).size,
    },
  };
}
