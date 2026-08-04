// Deterministic reason extraction from IMR findings text. Keyword rules in a
// fixed order — no model, no scoring, same text always yields the same tags.
// These tags power the backward-looking reliability battery: they connect
// what independent reviewers actually argued about to the requirement kinds
// our graph models (conservative therapy, documentation, necessity…).

const RULES = [
  ['conservative_therapy', /\b(conservative (?:treatment|therapy|care|management)|physical therapy|chiropractic|failed? (?:a )?(?:course|trial)s? of)\b/i],
  ['documentation', /\b(documentation|medical records?|clinical (?:notes?|information)|records? (?:submitted|provided|reviewed) (?:did|do) not|insufficient (?:information|documentation))\b/i],
  ['medical_necessity', /\b(not medically necessary|medical(?:ly)? necess)/i],
  ['experimental', /\b(experimental|investigational)\b/i],
  ['imaging_specific', /\b(MRI|magnetic resonance|CT scan|computed tomography|PET scan|imaging stud)/i],
  ['urgent_or_redflag', /\b(urgent|emergen|red flag|cauda equina|progressive neuro)/i],
];

export function extractReasons(findingsText) {
  const text = String(findingsText || '');
  const tags = [];
  for (const [tag, re] of RULES) if (re.test(text)) tags.push(tag);
  return tags;
}

export function normalizeDetermination(det) {
  const d = String(det || '').toLowerCase();
  if (d.includes('overturned') || d.includes('reversed')) return 'overturned';
  if (d.includes('upheld')) return 'upheld';
  return 'other';
}
