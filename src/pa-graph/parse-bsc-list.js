// Parser: Blue Shield of California prior-authorization list (PDF text).
// Deterministic table extraction — no LLM anywhere near this path. The
// document is "<policy name> <comma-separated CPT/HCPCS codes>" rows, with
// three wrinkles handled here: names wrap across lines before their first
// code; the PDF text sometimes glues a name to its first code
// ("Remodeling21600"); and delegated programs (RadMD / CarePro) are bulleted
// blocks with no codes at all. The tail carries a monthly "Codes Added /
// Codes Removed" changelog we keep as diff metadata.

// CPT: 5 digits or 4 digits + letter (Category III). HCPCS: letter + 4 digits.
const CODE_RE = /^(?:\d{5}|\d{4}[A-Z]|[A-Z]\d{4})$/;
const CODE_SCAN = /(\d{5}|\d{4}[A-Z]|[A-Z]\d{4})/g;

const DELEGATES = {
  RadMD: { vendor: 'RadMD (Evolent / National Imaging Associates)', programs: {
    'Advanced Imaging': 'advanced_imaging',
    'Spine Surgery': 'spine_surgery',
    'Interventional Pain Management': 'interventional_pain',
  } },
  CarePro: { vendor: 'CarePro', programs: {
    'Radiation Oncology': 'oncology',
    'Medical Oncology (drugs paid under the medical benefit)': 'oncology',
  } },
};

const NOISE = [
  /^Page \d+ of \d+$/i,
  /^Prior Authorization List for Blue Shield$/i,
  /^\(This List is updated monthly\)$/i,
  /^Effective\s+/i,
  /^Policy Name\/Program Procedure Code/i,
];

function months() {
  return ['january', 'february', 'march', 'april', 'may', 'june', 'july',
    'august', 'september', 'october', 'november', 'december'];
}

/** "Effective August 1, 2026" → "2026-08-01" */
export function effectiveDateFrom(text) {
  const m = text.match(/Effective\s+([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/);
  if (!m) return null;
  const mi = months().indexOf(m[1].toLowerCase());
  if (mi < 0) return null;
  return `${m[3]}-${String(mi + 1).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
}

/** Split tokens glued to a following code: "Remodeling21600" → "Remodeling 21600". */
function unglue(line) {
  return line.replace(/([a-zA-Z\)\*])(?=(?:\d{5}|\d{4}[A-Z]|[A-Z]\d{4})\b)/g, '$1 ');
}

export function parseBscList(text, { source, sha256, fetched_at } = {}) {
  const effective_from = effectiveDateFrom(text);
  const rawLines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  // Drop headers/footers and the AuthAccel intro paragraph (everything before
  // the first line that contains a code, once past the column header).
  const lines = rawLines.filter((l) => !NOISE.some((re) => re.test(l)));
  let start = lines.findIndex((l) => unglue(l).split(/[\s,]+/).some((t) => CODE_RE.test(t)));
  if (start < 0) start = 0;

  const rules = [];
  const changelog = { added: [], removed: [] };
  const delegatedNames = new Set(
    Object.values(DELEGATES).flatMap((d) => Object.keys(d.programs)),
  );

  let nameParts = [];
  let codes = [];
  let mode = 'entries'; // entries | added | removed
  let pendingDelegate = null;

  const flush = () => {
    if (codes.length) {
      const policy = nameParts.join(' ').replace(/\s+/g, ' ').trim();
      rules.push({ kind: 'code', requirement: 'prior_auth', policy, codes: [...new Set(codes)] });
    }
    nameParts = [];
    codes = [];
  };

  for (let i = start; i < lines.length; i++) {
    const line = lines[i];

    if (/^Codes Added$/i.test(line)) { flush(); mode = 'added'; continue; }
    if (/^Codes Removed$/i.test(line)) { mode = 'removed'; continue; }
    if (mode !== 'entries') {
      if (!/^None/i.test(line)) {
        const found = line.match(CODE_SCAN) || [];
        changelog[mode].push(...found);
      }
      continue;
    }

    // Delegated-program blocks: "RadMD" / "CarePro" followed by "• Program".
    if (DELEGATES[line]) { flush(); pendingDelegate = line; continue; }
    if (pendingDelegate && /^•/.test(line)) {
      const program = line.replace(/^•\s*/, '').trim();
      const del = DELEGATES[pendingDelegate];
      const category_key = del.programs[program];
      if (category_key) {
        rules.push({
          kind: 'category', requirement: 'prior_auth_delegated',
          policy: program, delegate: del.vendor, category_key,
        });
      }
      continue;
    }
    if (pendingDelegate && !/^•/.test(line)) pendingDelegate = null;
    // The PDF repeats delegated program names as bare column rows — skip them.
    if (delegatedNames.has(line)) continue;

    const tokens = unglue(line).split(/[\s,]+/).filter(Boolean);
    const hasCode = tokens.some((t) => CODE_RE.test(t));
    const allCodes = tokens.every((t) => CODE_RE.test(t));

    if (!hasCode) {
      // A fresh name line after codes closes the previous entry.
      if (codes.length) flush();
      nameParts.push(line);
      continue;
    }
    if (allCodes) { codes.push(...tokens); continue; }
    // Mixed line: name (possibly closing previous entry) then its first codes.
    if (codes.length) flush();
    const firstCode = tokens.findIndex((t) => CODE_RE.test(t));
    nameParts.push(tokens.slice(0, firstCode).join(' '));
    codes.push(...tokens.slice(firstCode).filter((t) => CODE_RE.test(t)));
  }
  flush();

  return {
    source_id: source?.id || 'blueshield-commercial-pa-list',
    payer_id: source?.payer_id || 'blueshield_ca',
    payer_name: source?.payer_name || 'Blue Shield of California',
    lob: source?.lob || 'commercial',
    document: { title: 'Prior Authorization List for Blue Shield', url: source?.url || null },
    effective_from,
    sha256: sha256 || null,
    fetched_at: fetched_at || null,
    rules,
    changelog,
    stats: {
      code_rules: rules.filter((r) => r.kind === 'code').length,
      category_rules: rules.filter((r) => r.kind === 'category').length,
      distinct_codes: new Set(rules.flatMap((r) => r.codes || [])).size,
    },
  };
}
