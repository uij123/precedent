// Curated code→category mappings for DELEGATED programs. Payers name the
// program ("Advanced Imaging" via RadMD) without listing codes in their own
// PA document — the delegate publishes those separately. Until the delegate
// list is ingested as its own source, this mapping answers code membership.
// It is data, it is ours, and every resolution that uses it says so in the
// derivation. Ranges are inclusive CPT ranges; singles are exact codes.

export const CATEGORY_CODE_MAP = {
  advanced_imaging: {
    label: 'Advanced imaging (MR, CT, PET, nuclear cardiology)',
    curated: true,
    ranges: [
      ['70336', '70336'],   // MRI temporomandibular joint
      ['70450', '70498'],   // CT/CTA head, orbit, neck
      ['70540', '70559'],   // MRI/MRA head, orbit, face, neck
      ['71250', '71275'],   // CT/CTA chest
      ['71550', '71555'],   // MRI/MRA chest
      ['72125', '72133'],   // CT spine (cervical, thoracic, lumbar)
      ['72141', '72159'],   // MRI spine (includes 72148 lumbar)
      ['72191', '72198'],   // CT/CTA + MRI/MRA pelvis
      ['73200', '73225'],   // CT/MRI upper extremity
      ['73700', '73725'],   // CT/MRI lower extremity (includes 73721 knee)
      ['74150', '74183'],   // CT/CTA + MRI abdomen (includes 74177)
      ['75557', '75574'],   // cardiac MRI + coronary CTA
      ['76390', '76390'],   // MR spectroscopy
      ['77046', '77049'],   // breast MRI
      ['78451', '78454'],   // myocardial perfusion (nuclear cardiology)
      ['78608', '78608'],   // brain PET
      ['78811', '78816'],   // PET / PET-CT
    ],
  },
  // Named by the payer as delegated, mapping not yet curated. Resolving a code
  // never silently attributes membership to these; they only appear in
  // derivation notes so the gap is visible instead of invisible.
  spine_surgery: { label: 'Spine surgery', curated: false, ranges: [] },
  interventional_pain: { label: 'Interventional pain management', curated: false, ranges: [] },
  oncology: { label: 'Radiation and medical oncology (medical-benefit drugs)', curated: false, ranges: [] },
};

/** Deterministic membership check: exact string-compare ranges on normalized codes. */
export function codeInCategory(code, categoryKey) {
  const cat = CATEGORY_CODE_MAP[categoryKey];
  if (!cat || !cat.curated) return false;
  const c = String(code).toUpperCase();
  return cat.ranges.some(([lo, hi]) => c >= lo && c <= hi && c.length === lo.length);
}
