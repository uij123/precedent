// Parser: Health Net California provider-library PA requirements page
// (server-rendered print variant; curl-able). Unlike Blue Shield and UHC,
// this list is SERVICE-NAME based — table rows of named services with X
// flags per age group, not CPT codes. That changes resolution semantics:
// a code that matches nothing here is UNKNOWN (unmapped), never "no PA".
// Extracted exactly: the effective date, the delegated programs (Evolent for
// advanced imaging, TurningPoint for musculoskeletal/spine), the one explicit
// CPT list (proprietary lab U-codes), and every named service row.
const CODE_SCAN = /(\d{5}|\d{4}[A-Z]|[A-Z]\d{4})/g;

function months() {
  return ['january', 'february', 'march', 'april', 'may', 'june', 'july',
    'august', 'september', 'october', 'november', 'december'];
}

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;|&[a-z]+;/gi, ' ');
}

export function hnEffectiveDate(text) {
  const m = text.match(/Effective\s+([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/);
  if (!m) return null;
  const mi = months().indexOf(m[1].toLowerCase());
  if (mi < 0) return null;
  return `${m[3]}-${String(mi + 1).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
}

export function parseHnPage(html, { source, sha256, fetched_at } = {}) {
  const text = stripTags(html);
  const effective_from = hnEffectiveDate(text);
  const rules = [];

  // Delegated advanced imaging via Evolent — stated in the Diagnostic
  // procedures row ("Authorized by Evolent … Advanced imaging: CT … MRI … PET").
  if (/Authorized\s+by\s+Evolent/i.test(text) && /Advanced\s+imaging/i.test(text)) {
    rules.push({
      kind: 'category', requirement: 'prior_auth_delegated',
      policy: 'Diagnostic procedures (advanced and cardiac imaging)',
      delegate: 'Evolent Specialty Services, Inc.',
      category_key: 'advanced_imaging',
    });
  }
  // Musculoskeletal / spine via TurningPoint — named without codes.
  if (/TurningPoint\s+Healthcare\s+Solutions/i.test(text)) {
    rules.push({
      kind: 'category', requirement: 'prior_auth_delegated',
      policy: 'Musculoskeletal, joint and spinal surgery (adults)',
      delegate: 'TurningPoint Healthcare Solutions, LLC',
      category_key: 'spine_surgery',
    });
  }

  // The one explicit CPT list: proprietary laboratory analyses (U-codes).
  const labIdx = text.indexOf('Proprietary laboratory analyses');
  if (labIdx > -1) {
    const window = text.slice(labIdx, labIdx + 600);
    const codes = [...new Set(window.match(CODE_SCAN) || [])].filter((c) => /U$/.test(c));
    if (codes.length) {
      rules.push({ kind: 'code', requirement: 'prior_auth', policy: 'Proprietary laboratory analyses', codes });
    }
  }

  // Service rows: <tr> cells; a row whose flag cells contain X is PA-required.
  const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  for (const row of rows) {
    const cells = (row.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || [])
      .map((c) => stripTags(c).replace(/\s+/g, ' ').trim());
    if (cells.length < 2) continue;
    const flags = cells.slice(1).map((c) => c === 'X');
    if (!flags.some(Boolean)) continue;
    const body = cells[0];
    if (!body || body.length < 3 || /^X$/.test(body)) continue;
    const name = body.split(/(?<=[a-z\)])\s+(?=[A-Z])/)[0].slice(0, 120).trim();
    const delegateM = body.match(/Authorized by ([A-Z][A-Za-z .,&()-]+?)(?:\s{2,}|$|[.;])/);
    rules.push({
      kind: 'service', requirement: 'prior_auth',
      policy: name || body.slice(0, 80),
      notes: body.length > name.length ? body.slice(name.length).trim().slice(0, 300) : undefined,
      delegate: delegateM ? delegateM[1].trim() : undefined,
      adult: flags[0] ?? null,
      pediatric: flags[1] ?? flags[0] ?? null,
    });
  }

  return {
    source_id: source?.id || 'healthnet-medical-pa-page',
    payer_id: source?.payer_id || 'healthnet_ca',
    payer_name: source?.payer_name || 'Health Net of California',
    lob: source?.lob || 'medi-cal',
    match_basis: 'service_names',
    document: {
      title: 'Health Net Prior Authorization Requirements — Medi-Cal',
      url: source?.url || null,
      note: 'Service-name based list; codes appear only for proprietary lab analyses. Unmatched codes resolve UNKNOWN by design.',
    },
    effective_from,
    sha256: sha256 || null,
    fetched_at: fetched_at || null,
    rules,
    changelog: { added: [], removed: [] },
    stats: {
      code_rules: rules.filter((r) => r.kind === 'code').length,
      category_rules: rules.filter((r) => r.kind === 'category').length,
      service_rules: rules.filter((r) => r.kind === 'service').length,
      distinct_codes: new Set(rules.flatMap((r) => r.codes || [])).size,
    },
  };
}
