// Execution chains (spec §9), run on the RocketRide-shaped chain runner:
//   submit-chain: query graph → assemble packet (+PDFs) → confirmation email →
//                 POST payer simulator → await verdict → publish to
//                 payer.verdicts (+ mirror to network.events) → write-back →
//                 notify. Idempotent by submission_id.
//   appeal fixes: deterministic mapping from denial reason codes to packet
//                 corrections; unfixable reasons become recommendations.
//   notify-chain: final outcome email.
import { packetFromChecklist } from '../core/decide.js';
import { REQ_LABELS } from '../core/decide.js';
import { writeAttachments, makePdf } from '../domain/pdfs.js';
import { payerName, procedureLabel, procedureShort, DIAGNOSIS } from '../domain/payers.js';
import { nowIso } from '../util.js';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';

export function createChainService({ runner, graph, bus, email, cases, config, attachmentsDir, onVerdict }) {
  const payerBase = () => `http://127.0.0.1:${config.payerPort}`;

  runner.define('submit-chain', [
    {
      name: 'query-graph-requirements',
      async run(ctx) {
        // The learned rulebook for this payer, straight from the graph — the
        // packet is assembled against what the network has learned.
        ctx.requirements = await graph.getRequirements(ctx.input.payer_id);
        return { learned: ctx.requirements.length };
      },
    },
    {
      name: 'assemble-packet',
      async run(ctx) {
        const { facts, checklist, patient, submission_id } = ctx.input;
        ctx.packet = packetFromChecklist(facts, checklist);
        ctx.files = writeAttachments({
          dir: join(attachmentsDir, submission_id), patient, facts, checklist,
          procedure: procedureLabel(ctx.input.cpt),
        });
        await graph.createSubmission({
          submission_id,
          consult_id: ctx.input.consult_id,
          patient_id: patient.id,
          payer_id: ctx.input.payer_id,
          cpt: ctx.input.cpt,
          packet: ctx.packet,
          status: 'ASSEMBLED',
          ts: nowIso(),
        });
        return { packet: ctx.packet, attachments: ctx.files.map((f) => f.label) };
      },
    },
    {
      name: 'confirmation-email',
      async run(ctx) {
        const { patient, payer_id, submission_id, checklist } = ctx.input;
        const contents = checklist.filter((i) => i.included).map((i) => `  · ${i.label}`).join('\n');
        // The packet itself rides along: a generated cover sheet plus every
        // synthetic document the checklist included. All PDFs, all fictional.
        const coverPath = join(attachmentsDir, submission_id, 'submission-packet.pdf');
        writeFileSync(coverPath, makePdf([
          'PRIOR AUTHORIZATION SUBMISSION PACKET (SYNTHETIC DEMO DOCUMENT)',
          `Submission: ${submission_id}`,
          `Patient: ${patient.name}`,
          `Payer: ${payerName(payer_id)}`,
          `Study: ${procedureLabel(ctx.input.cpt)} - CPT ${ctx.input.cpt || '72148'}`,
          `Diagnosis: ${ctx.packet.dx}`,
          `Documented conservative therapy: ${ctx.packet.therapy_weeks ?? '?'} week(s)`,
          `PT provider notes attached: ${ctx.packet.pt_notes ? 'yes' : 'no'}`,
          `Red-flag screening documented: ${ctx.packet.redflag_screen ? 'yes' : 'no'}`,
          `Imaging order form attached: ${ctx.packet.order_form ? 'yes' : 'no'}`,
          `Red flags present: ${ctx.packet.redflags_present ? 'yes' : 'no'}`,
          `Assembled: ${nowIso()}`,
        ]));
        const attachments = [
          { filename: 'submission-packet.pdf', content: readFileSync(coverPath).toString('base64') },
          ...ctx.files.map((f) => ({
            filename: f.path.split('/').pop(),
            content: readFileSync(f.path).toString('base64'),
          })),
        ];
        await email.send({
          key: `${submission_id}:submitted`,
          subject: `Prior auth submitted: ${patient.name}, ${payerName(payer_id)} (${submission_id})`,
          text: `Submission sent to ${payerName(payer_id)} for ${patient.name}.\nCPT ${ctx.input.cpt || '72148'}, ${procedureLabel(ctx.input.cpt)}. Dx ${ctx.packet.dx}.\n\nPacket contents:\n${contents}\n\nThe full packet is attached: ${attachments.map((a) => a.filename).join(', ')}.\n\nPrecedent. Synthetic demo, no real patient data.`,
          attachments,
        });
        return { emailed: true, attachments: attachments.length };
      },
    },
    {
      name: 'submit-and-await-verdict',
      async run(ctx) {
        const { submission_id, payer_id, case_id } = ctx.input;
        await cases.transition(case_id, 'SUBMITTED', { submission_id });
        await cases.transition(case_id, 'AWAITING_PAYER', { submission_id });
        const res = await fetch(`${payerBase()}/payer/${payer_id}/submit${ctx.input.delay_ms !== undefined ? `?delay_ms=${ctx.input.delay_ms}` : ''}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ submission_id, packet: ctx.packet }),
        });
        if (!res.ok) throw new Error(`payer sim ${res.status}`);
        ctx.verdict = await res.json();
        return { outcome: ctx.verdict.outcome, reason_codes: ctx.verdict.reason_codes };
      },
    },
    {
      name: 'publish-verdict',
      async run(ctx) {
        const { submission_id, payer_id } = ctx.input;
        const evt = {
          submission_id,
          payer_id,
          cpt: ctx.input.cpt || '72148',
          outcome: ctx.verdict.outcome,
          reason_codes: ctx.verdict.reason_codes,
          reason_params: ctx.verdict.reason_params || {},
          packet: ctx.packet,
          ts: nowIso(),
        };
        await bus.publish('payer.verdicts', evt); // ingest learns + writes back to the graph
        await bus.publish('network.events', {    // our outcome joins the network feed
          event_id: `ne-${submission_id}`,
          clinic_id: 'clinic-ours',
          mirrored_from: submission_id,
          payer_id, cpt: ctx.input.cpt || '72148', packet: ctx.packet,
          outcome: evt.outcome, reason_codes: evt.reason_codes, reason_params: evt.reason_params,
          ts: evt.ts,
        });
        return { published: true };
      },
    },
    {
      name: 'record-and-notify',
      async run(ctx) {
        const { case_id, submission_id } = ctx.input;
        const v = ctx.verdict;
        await cases.transition(case_id, 'VERDICT_RECEIVED', {
          submission_id, outcome: v.outcome, note: v.reason_codes.join(', ') || v.outcome,
        });
        await runner.trigger('notify-chain', {
          key: `${submission_id}:notify`,
          input: { ...ctx.input, verdict: v },
        });
        await onVerdict?.({ caseId: case_id, input: ctx.input, verdict: v, packet: ctx.packet });
        return { done: true };
      },
    },
  ]);

  runner.define('notify-chain', [
    {
      name: 'outcome-email',
      async run(ctx) {
        const { patient, payer_id, submission_id, verdict } = ctx.input;
        const reasons = verdict.reason_codes.length
          ? verdict.reason_codes.map((c) => `  · ${REQ_LABELS[c] || c}`).join('\n')
          : '  None. Approved.';
        await email.send({
          key: `${submission_id}:verdict`,
          subject: `Verdict ${verdict.outcome.toLowerCase()}: ${patient.name}, ${payerName(payer_id)} (${submission_id})`,
          text: `Verdict: ${verdict.outcome}\n\nPayer: ${payerName(payer_id)}\nPatient: ${patient.name}\nStudy: CPT ${ctx.input.cpt || '72148'}, ${procedureLabel(ctx.input.cpt)}. Dx ${DIAGNOSIS.code}.\n\nReasons:\n${reasons}\n\nPrecedent. Synthetic demo, no real patient data.`,
        });
        return { emailed: true };
      },
    },
  ]);

  return {
    /**
     * Kick off a submission for an approved checklist. Returns immediately;
     * the chain runs in the background (the payer holds the verdict for the
     * configured processing delay).
     */
    async submitCase({ caseRec, facts, checklist, attempt = 1, delayMs }) {
      const submission_id = `sub-${caseRec.case_id}-a${attempt}`;
      await cases.transition(caseRec.case_id, 'EXECUTING', { submission_id, attempt });
      const input = {
        case_id: caseRec.case_id,
        consult_id: caseRec.consult_id,
        patient: caseRec.patient,
        payer_id: caseRec.payer_id,
        cpt: caseRec.cpt || '72148',
        submission_id, facts, checklist, attempt,
        ...(delayMs !== undefined ? { delay_ms: delayMs } : {}),
      };
      const pending = runner.trigger('submit-chain', { key: submission_id, input })
        .catch((e) => console.error('[submit-chain]', e.message));
      return { submission_id, pending };
    },

    /**
     * Deterministic appeal analysis (spec §9 appeal-chain step 1): map each
     * denial reason code to a packet fix, or an action when paperwork can't
     * fix it.
     */
    appealFixes({ verdict, facts, checklist }) {
      const fixes = [];
      const unfixable = [];
      for (const code of verdict.reason_codes) {
        const params = verdict.reason_params?.[code] || {};
        switch (code) {
          case 'PT_NOTES_MISSING':
            if (facts.pt_notes_available === true) {
              fixes.push({ key: 'pt_notes', kind: 'attachment', label: 'PT provider session notes (PDF) — attached', included: true, reason: 'learned-requirement', requirement_code: code, satisfied: true });
            } else {
              unfixable.push({ code, action: 'Request session notes from the PT provider, then appeal.' });
            }
            break;
          case 'ORDER_FORM_MISSING':
            fixes.push({ key: 'order_form', kind: 'attachment', label: 'Imaging order form (PDF) — attached', included: true, reason: 'learned-requirement', requirement_code: code, satisfied: true });
            break;
          case 'REDFLAG_SCREEN_MISSING':
            if (facts.redflags === 'absent' || facts.redflags === 'present') {
              fixes.push({ key: 'redflag_screen', kind: 'field', label: `Red-flag screening — documented (${facts.redflags})`, included: true, reason: 'learned-requirement', requirement_code: code, satisfied: true });
            } else {
              unfixable.push({ code, action: 'Run the red-flag screening questions with the patient, then appeal.' });
            }
            break;
          case 'DIAGNOSIS_CODE_INVALID':
            fixes.push({ key: 'dx', kind: 'field', label: 'Diagnosis code M54.5 (Low back pain) — corrected', included: true, reason: 'learned-requirement', requirement_code: code, satisfied: true });
            break;
          case 'THERAPY_DURATION_INSUFFICIENT': {
            const required = params.required_weeks;
            const have = facts.therapy_weeks ?? 0;
            if (Number.isFinite(required) && have >= required) {
              fixes.push({ key: 'therapy', kind: 'field', label: `Conservative therapy summary — ${have} weeks documented`, included: true, reason: 'learned-requirement', requirement_code: code, satisfied: true });
            } else {
              const gap = Number.isFinite(required) ? required - have : null;
              unfixable.push({
                code,
                action: gap
                  ? `Cannot appeal on paperwork — patient genuinely has ${have} week(s) documented. Recommend ${gap} more week(s) of therapy, then resubmit.`
                  : 'Extend documented conservative therapy, then resubmit.',
              });
            }
            break;
          }
          default:
            unfixable.push({ code, action: 'Manual review needed.' });
        }
      }
      // Merge fixes into the previously approved checklist (fixes win by key).
      const merged = [...checklist.filter((i) => !fixes.some((f) => f.key === i.key)), ...fixes];
      return { fixable: fixes, unfixable, checklist: merged, appealable: unfixable.length === 0 && fixes.length > 0 };
    },
  };
}
