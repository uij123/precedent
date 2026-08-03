// Synthetic PDF attachments (PT provider notes, imaging order form) — small
// but genuinely valid PDF files, generated on demand and referenced by the
// packet. Entirely fictional content, per the synthetic-data-only rule.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Minimal single-page PDF with the given text lines. Valid per PDF 1.4. */
export function makePdf(lines) {
  const textOps = lines.map((l, i) => `BT /F1 11 Tf 54 ${740 - i * 16} Td (${escape(l)}) Tj ET`).join('\n');
  const objects = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  objects[3] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>';
  const stream = textOps;
  objects[4] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  objects[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  let out = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 1; i <= 5; i++) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 6\n0000000000 65535 f \n${[1, 2, 3, 4, 5].map((i) => `${String(offsets[i]).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

function escape(s) {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

export function writeAttachments({ dir, patient, facts, checklist, procedure = 'MRI lumbar spine without contrast - CPT 72148' }) {
  mkdirSync(dir, { recursive: true });
  const files = [];
  const has = (key) => checklist.some((i) => i.key === key && i.included);

  if (has('pt_notes')) {
    const path = join(dir, 'pt-provider-notes.pdf');
    writeFileSync(path, makePdf([
      'PHYSICAL THERAPY — SESSION NOTES (SYNTHETIC DEMO DOCUMENT)',
      `Patient: ${patient.name}`,
      `Provider: ${facts.therapy_provider || 'PT provider'}`,
      `Documented duration: ${facts.therapy_weeks ?? '?'} week(s), 2x/week`,
      'Course: guided lumbar stabilization, progressive loading, home program.',
      'Response: partial relief; radicular symptoms persist with sitting.',
    ]));
    files.push({ key: 'pt_notes', label: 'PT provider session notes (PDF)', path });
  }
  if (has('order_form')) {
    const path = join(dir, 'imaging-order-form.pdf');
    writeFileSync(path, makePdf([
      'IMAGING ORDER FORM (SYNTHETIC DEMO DOCUMENT)',
      `Patient: ${patient.name}`,
      `Study: ${procedure}`,
      'Diagnosis: M54.5 (low back pain)',
      'Ordering clinician: (demo clinic)',
    ]));
    files.push({ key: 'order_form', label: 'Imaging order form (PDF)', path });
  }
  return files;
}
