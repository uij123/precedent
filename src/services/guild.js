// Judgment layer (spec §8): two Guild agents debate ON TOP of the
// deterministic decision core's output — they explain and argue, they never
// decide. Plus the human-in-the-loop gate (spec §7): the checklist is posted
// with Approve/Reject and NOTHING executes before Approve.
//
// VENUE WIRING (Guild.ai is closed beta — browser auth + private registry):
// `guild/` contains ready-to-paste agent.ts definitions for both agents
// (guild agent init → paste → guild agent save --publish). The local
// coordinator below mirrors Guild's model: registered agents with one narrow
// job each, coordinated per case, human gate between deciding and doing.
import { payerName } from '../domain/payers.js';
import { id, nowIso, fmtDuration } from '../util.js';
import { report } from '../adapters/status.js';

export const AGENTS = {
  clinical: {
    id: 'clinical-criteria-agent',
    description: 'Argues from the medicine: guideline logic (6 weeks conservative therapy standard, red-flag exceptions). Reads consult Facts.',
  },
  payer: {
    id: 'payer-policy-agent',
    description: 'Argues from the graph: learned payer requirements, denial precedents, confidence levels.',
  },
};

const CLINICAL_STANDARD_WEEKS = 6; // clinical guideline, not a payer quirk

export function createGuild({ llm, config }) {
  report('Guild.ai', {
    mode: config.guildWorkspace ? 'live' : 'local-fallback',
    detail: config.guildWorkspace
      ? `workspace ${config.guildWorkspace}`
      : 'local coordinator — agents in guild/*.agent.ts ready for `guild agent init` at the venue',
  });

  const approvals = new Map(); // approval_id -> record

  function clinicalPosition({ facts }) {
    const weeks = facts.therapy_weeks;
    if (facts.redflags === 'present') {
      return {
        stance: 'IMAGE_URGENT',
        text: 'Red flags documented (cauda equina pattern). Guidelines are unambiguous: urgent MRI now, conservative-therapy duration is irrelevant. Do not wait for routine authorization — payers expedite documented red flags.',
      };
    }
    if (weeks === undefined || weeks === null) {
      return {
        stance: 'DOCUMENT_FIRST',
        text: `Persistent radicular low-back pain can justify MRI, but the guideline anchor is ~${CLINICAL_STANDARD_WEEKS} weeks of documented conservative therapy — and this consult does not document a duration yet. Establish and document the therapy history before ordering.`,
      };
    }
    if (weeks < CLINICAL_STANDARD_WEEKS) {
      const gap = CLINICAL_STANDARD_WEEKS - weeks;
      return {
        stance: 'WAIT',
        text: `Guideline view: MRI for uncomplicated radicular low-back pain is indicated after ~${CLINICAL_STANDARD_WEEKS} weeks of conservative therapy. This patient has ${weeks} documented week(s) and a negative red-flag screen. Imaging today is clinically defensible but early — ${gap} more week(s) of PT puts the order inside guideline.`,
      };
    }
    return {
      stance: 'IMAGE_NOW',
      text: `${weeks} weeks of documented conservative therapy with persistent radicular symptoms and a negative red-flag screen — imaging is guideline-appropriate now.`,
    };
  }

  function payerPosition({ payerId, prediction }) {
    const name = payerName(payerId);
    const ev = (r) => `${r.evidence_count} event${r.evidence_count === 1 ? '' : 's'}, confidence ${(r.req_confidence * 100).toFixed(0)}%`;

    if (prediction.prediction === 'LIKELY_EXPEDITED') {
      return { stance: 'SUBMIT_NOW', text: `Submit immediately on the expedited pathway — documented red flags short-circuit ${name}'s routine requirements.` };
    }
    if (prediction.prediction === 'UNKNOWN' && prediction.items.length === 0) {
      return {
        stance: 'INSUFFICIENT_MEMORY',
        text: `The graph holds no precedents for ${name} yet — I cannot predict their behavior. Every verdict on the network sharpens this; give the memory a few minutes of events or submit to create the first precedent.`,
      };
    }
    const unfixable = prediction.missing.filter((m) => m.code === 'THERAPY_DURATION_INSUFFICIENT' && m.status === 'unmet');
    const paperwork = prediction.missing.filter((m) => m.code !== 'THERAPY_DURATION_INSUFFICIENT' && m.status === 'unmet');
    const lines = [];
    for (const item of prediction.items) {
      const flag = item.status === 'met' ? '✓' : item.status === 'auto' ? '•' : '✗';
      lines.push(`${flag} ${item.label} — ${item.detail} (${ev(item)})`);
    }
    if (prediction.prediction === 'LIKELY_APPROVED') {
      return { stance: 'SUBMIT_NOW', text: `${name}'s learned rulebook is satisfied on every requirement the network has observed:\n${lines.join('\n')}\nSubmit now — first-pass approval expected.` };
    }
    if (unfixable.length) {
      const gap = unfixable[0].gap_weeks;
      return {
        stance: 'WAIT',
        text: `${name} will deny this as it stands:\n${lines.join('\n')}\nThe duration shortfall cannot be papered over — the patient genuinely has the weeks they have. ${gap ? `Recommend ${gap} more week(s) of documented therapy, then submit${paperwork.length ? ' with the paperwork fixes below' : ''}.` : ''}`,
      };
    }
    if (paperwork.length) {
      return {
        stance: 'SUBMIT_WITH_FIXES',
        text: `${name} would deny the bare order, but every missing item is paperwork we can fix in this packet:\n${lines.join('\n')}\nAttach the fixes and submit now.`,
      };
    }
    return { stance: 'SUBMIT_TO_TEST', text: `${name}'s threshold is only partially mapped:\n${lines.join('\n')}\nSubmitting now tests the untested band and teaches the network either way; waiting is the conservative play.` };
  }

  return {
    agents: AGENTS,

    /** The case-review meeting: both agents position themselves, disagreement is surfaced, the human decides. */
    async debate({ caseId, payerId, facts, prediction }) {
      const clinical = clinicalPosition({ facts });
      const payer = payerPosition({ payerId, prediction });

      const AGREE_SETS = {
        IMAGE_URGENT: ['SUBMIT_NOW'],
        IMAGE_NOW: ['SUBMIT_NOW', 'SUBMIT_WITH_FIXES'],
        WAIT: ['WAIT'],
        DOCUMENT_FIRST: ['WAIT', 'INSUFFICIENT_MEMORY'],
      };
      const agree = (AGREE_SETS[clinical.stance] || []).includes(payer.stance);

      const positions = [
        {
          agent: AGENTS.clinical.id, stance: clinical.stance,
          text: await llm.prose({
            purpose: 'debate', caseId,
            system: `You are ${AGENTS.clinical.id}: ${AGENTS.clinical.description} Ground every claim in the provided facts; never invent clinical history. 2-4 sentences.`,
            prompt: `Facts: ${JSON.stringify(facts)}\nDeterministic position to argue (do not change the recommendation): ${clinical.stance} — ${clinical.text}`,
            fallbackText: clinical.text,
          }),
        },
        {
          agent: AGENTS.payer.id, stance: payer.stance,
          text: await llm.prose({
            purpose: 'debate', caseId,
            system: `You are ${AGENTS.payer.id}: ${AGENTS.payer.description} Cite only the learned requirements and evidence provided; never invent precedents. Keep the ✓/✗ lines.`,
            prompt: `Payer: ${payerName(payerId)}\nDeterministic prediction: ${JSON.stringify({ prediction: prediction.prediction, confidence: prediction.confidence, missing: prediction.missing.map((m) => m.code) })}\nPosition to argue (do not change the recommendation): ${payer.stance} — ${payer.text}`,
            fallbackText: payer.text,
          }),
        },
      ];

      return {
        positions,
        convergence: agree ? 'agree' : 'disagree',
        resolution: agree
          ? 'Both agents converge. The recommendation stands — your call to proceed.'
          : `The agents disagree (${AGENTS.clinical.id}: ${clinical.stance} vs ${AGENTS.payer.id}: ${payer.stance}). Both positions are shown — the decision is yours.`,
      };
    },

    /** Post the to-do list for human approval. Nothing executes before Approve (spec §7). */
    requestApproval({ caseId, kind, checklist, prediction, note }) {
      const rec = {
        approval_id: id('appr'), case_id: caseId, kind, checklist, note: note || null,
        prediction: prediction ? { prediction: prediction.prediction, confidence: prediction.confidence } : null,
        status: 'pending', requested_at: nowIso(), resolved_at: null,
      };
      approvals.set(rec.approval_id, rec);
      return rec;
    },

    resolveApproval(approvalId, decision) {
      const rec = approvals.get(approvalId);
      if (!rec) throw new Error(`unknown approval ${approvalId}`);
      if (rec.status !== 'pending') return rec; // double-click safe
      rec.status = decision; // 'approved' | 'rejected'
      rec.resolved_at = nowIso();
      rec.waited_ms = Date.parse(rec.resolved_at) - Date.parse(rec.requested_at);
      return rec;
    },

    getApproval: (approvalId) => approvals.get(approvalId) || null,
    pendingApprovals: () => [...approvals.values()].filter((a) => a.status === 'pending'),

    /** Human-readable evidence line for interjections: "denied 3 similar — last one 12 min ago". */
    evidenceLine(requirement) {
      const denials = (requirement.evidence || []).filter((e) => e.outcome === 'DENIED');
      if (!denials.length) return null;
      const last = denials[0];
      const ago = Date.now() - Date.parse(last.ts);
      const who = last.src_kind === 'submission' ? 'our own submission' : (last.clinic_id || 'a network clinic');
      return `${payerName(requirement.payer_id || '')}`.trim() === ''
        ? `denied ${denials.length} similar request(s) — most recent ${fmtDuration(ago)} ago (${who})`
        : `denied ${denials.length} similar request(s) — most recent ${fmtDuration(ago)} ago (${who})`;
    },
  };
}
