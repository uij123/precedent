// Chat Q&A (spec §7): free-text questions answered ONLY from the
// deterministic prediction + graph query results. The what-if engine is the
// star: "what if we wait two weeks?" is a pure recomputation, not an opinion.
// The chat also serves as the graph console: it answers payer questions with
// no active visit, and raw read-only Cypher pasted into it runs directly.
import { whatIf } from '../core/decide.js';
import { payerName, PAYER_IDS, PROCEDURES } from '../domain/payers.js';

const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 };
const CYPHER_START = /^(MATCH|OPTIONAL\s+MATCH|RETURN|WITH|UNWIND)\b/i;

// Real California insurers the PA graph can answer for. Matching is by name;
// resolution is deterministic and cited — the LLM never touches these answers.
const REAL_PAYERS = [
  [/blue\s*shield/i, 'blueshield_ca'],
  [/anthem/i, 'anthem_ca'],
  [/health\s*net/i, 'healthnet_ca'],
  [/united\s*health|uhc\b/i, 'uhc_ca'],
  [/kaiser/i, 'kaiser_ca'],
];

export function createChat({ llm, consults, graph, graphQuery, pa }) {
  function payerFromText(text) {
    const t = text.toLowerCase();
    for (const pid of PAYER_IDS) {
      if (t.includes(pid) || t.includes(payerName(pid).toLowerCase().split(' ')[0])) return pid;
    }
    return null;
  }

  async function learnedWithEvidence(payerId) {
    const reqs = ((await graph.getRequirements(payerId)) || []).filter((r) => r.evidence_count > 0);
    for (const r of reqs) r.evidence = await graph.getRequirementEvidence(payerId, r.code, 2);
    return reqs;
  }

  function rulebookLines(name, learned) {
    return [`${name}'s learned rulebook — nobody typed these in, every line came from observed verdicts:`,
      ...learned.map((r) => `  · ${r.code}${r.params?.required_weeks ? ` (≥${r.params.required_weeks} weeks)` : ''} — ${r.evidence_count} events, confidence ${(r.confidence * 100).toFixed(0)}%`)].join('\n');
  }

  function evidenceLines(name, learned) {
    const lines = [];
    for (const r of learned) {
      for (const e of (r.evidence || []).slice(0, 2)) {
        lines.push(`  · ${e.outcome} @ ${e.src_kind === 'submission' ? 'our clinic' : e.clinic_id} (${r.code}${e.therapy_weeks !== null && e.therapy_weeks !== undefined ? `, ${e.therapy_weeks}w therapy` : ''}) — ${e.ts}`);
      }
    }
    return lines.length
      ? [`Recent ${name} precedents in the graph (multi-hop: payer → requirement ← outcome ← source):`, ...lines].join('\n')
      : `No ${name} precedents in the graph yet.`;
  }

  async function answer(caseId, text) {
    const q = text.trim();

    // Direct graph interrogation — raw Cypher pasted into the chat.
    if (CYPHER_START.test(q)) {
      const out = await graphQuery(q);
      if (out.error) return out.error;
      if (!out.rows.length) return 'Query ran. No rows.';
      const shown = out.rows.slice(0, 12);
      return [
        out.columns.join(' · '),
        ...shown.map((row) => `  ${row.map((v) => v ?? '–').join(' · ')}`),
        out.rows.length > shown.length ? `  …and ${out.rows.length - shown.length} more rows.` : '',
      ].filter(Boolean).join('\n');
    }

    // Real-payer questions resolve against the California PA graph, verbatim.
    if (pa) {
      const real = REAL_PAYERS.find(([re]) => re.test(q));
      const codeM = q.toUpperCase().match(/\b(\d{5}|\d{4}[A-Z]|[A-Z]\d{4})\b/);
      const study = Object.values(PROCEDURES).find((p) =>
        q.toLowerCase().includes(p.short.toLowerCase()) || q.toLowerCase().includes(p.label.toLowerCase()));
      if (real && (codeM || study)) {
        const code = codeM ? codeM[1] : study.cpt;
        const lob = /medi-?cal/i.test(q) ? 'medi-cal' : /medicare|advantage/i.test(q) ? 'medicare_advantage' : 'commercial';
        const r = pa.resolve({ payer: real[1], lob, code, asOf: new Date().toISOString().slice(0, 10) });
        return formatPaResolution(r, pa);
      }
    }

    const ctx = await consults.currentPredictionFor(caseId);

    // No active visit: the chat still answers straight from the memory graph.
    if (!ctx) {
      const pid = payerFromText(q);
      if (pid) {
        const name = payerName(pid);
        const learned = await learnedWithEvidence(pid);
        if (!learned.length) return `The graph has learned nothing about ${name} yet. It learns from every verdict on the network.`;
        if (/\b(evidence|precedent|history|how do you know)\b/i.test(q)) return evidenceLines(name, learned);
        return rulebookLines(name, learned);
      }
      if (/\b(graph|memory|learned|size|count|how (big|much))\b/i.test(q)) {
        const c = await graph.counts();
        const parts = Object.entries(c || {}).map(([k, v]) => `${v} ${k.replaceAll('_', ' ')}`);
        return `The memory graph holds ${parts.join(', ')}. Ask about a payer by name ("what does BluePeak require?") or paste a read-only Cypher query (MATCH …).`;
      }
      return 'No visit in progress. I can still answer from the memory graph: ask about a payer by name ("what does BluePeak require?"), or paste a read-only Cypher query starting with MATCH.';
    }

    const { payerId, prediction, requirements } = ctx;
    const session = consults.getSession(caseId);
    const facts = session.facts;
    const name = payerName(payerId);

    // what-if: wait N weeks
    const wait = q.match(/\b(?:wait|another|add|give it)\b.{0,20}?\b(\d+|one|two|three|four|five|six|seven|eight)\s*(?:more\s*)?weeks?/i);
    if (wait) {
      const n = NUM_WORDS[wait[1].toLowerCase()] ?? Number(wait[1]);
      const now = prediction.prediction;
      const then = whatIf({ payerId, facts, requirements, delta: { therapy_weeks: (facts.therapy_weeks ?? 0) + n } });
      return [
        `What-if, computed (not guessed): with ${n} more week${n === 1 ? '' : 's'} of documented therapy (${facts.therapy_weeks ?? 0} → ${(facts.therapy_weeks ?? 0) + n}):`,
        `  today: ${now} (confidence ${(prediction.confidence * 100).toFixed(0)}%)`,
        `  after waiting: ${then.prediction} (confidence ${(then.confidence * 100).toFixed(0)}%)`,
        then.missing.length ? `  still missing then: ${then.missing.map((m) => m.label).join('; ')}` : '  nothing missing then — packet would satisfy every learned requirement.',
      ].join('\n');
    }

    // missing / why
    if (/\b(missing|why|what.{0,15}(need|block|require)|what's wrong)\b/i.test(q)) {
      if (prediction.prediction === 'LIKELY_EXPEDITED') return 'Nothing — documented red flags put this on the expedited pathway.';
      if (!prediction.missing.length) return `Nothing. All ${prediction.items.length} learned ${name} requirements are satisfied — that's why I predict ${prediction.prediction}.`;
      return ['Exactly what\'s missing, per the learned rulebook:',
        ...prediction.missing.map((m) => `  · ${m.label} — ${m.detail}${m.action ? ` Fix: ${m.action}` : ''}`)].join('\n');
    }

    // rulebook / requirements — for the case's payer, or any payer named
    if (/\b(rulebook|requirements?|what does .{0,25}(want|demand|require)|policy)\b/i.test(q)) {
      const pid = payerFromText(q) || payerId;
      const learned = pid === payerId
        ? requirements.filter((r) => r.evidence_count > 0)
        : await learnedWithEvidence(pid);
      if (!learned.length) return `The graph has learned nothing about ${payerName(pid)} yet — no precedents observed. It learns from every verdict on the network.`;
      return rulebookLines(payerName(pid), learned);
    }

    // evidence / precedents
    if (/\b(evidence|precedent|denied before|history|how do you know)\b/i.test(q)) {
      return evidenceLines(name, requirements.filter((x) => x.evidence_count > 0));
    }

    // prediction / chances
    if (/\b(chances?|odds|likely|predict|approv)\b/i.test(q)) {
      return [`Current prediction for ${name}: ${prediction.prediction} (confidence ${(prediction.confidence * 100).toFixed(0)}%).`,
        prediction.narrative].join('\n');
    }

    return 'I can answer about this case\'s prediction, what\'s missing, the learned payer rulebook, denial precedents, and what-ifs ("what if we wait 2 weeks?"). I also take read-only Cypher directly. Everything I say is computed from the graph — I don\'t improvise.';
  }

  function formatPaResolution(r, paSvc) {
    const lines = [];
    const study = PROCEDURES[r.code] ? ` (${PROCEDURES[r.code].label})` : '';
    if (r.requirement_type === 'prior_auth') {
      lines.push(`${r.payer_name}, ${r.lob}: prior authorization IS required for ${r.code}${study}.`);
      lines.push(`Listed under: ${r.policies.join('; ')}.`);
    } else if (r.requirement_type === 'prior_auth_delegated') {
      lines.push(`${r.payer_name}, ${r.lob}: prior authorization IS required for ${r.code}${study}, managed by the delegate ${r.delegate}.`);
      const imr = paSvc.imrCategory('Diag Imag & Screen');
      if (imr) lines.push(`Context from state data: California IMR overturns ${Math.round(imr.overturn_rate * 100)}% of appealed imaging denials (${imr.total} cases since 2001, all plans).`);
    } else if (r.requirement_type === 'no_prior_auth_listed') {
      lines.push(`${r.payer_name}, ${r.lob}: no prior authorization is listed for ${r.code}${study} on the list in force.`);
    } else {
      lines.push(`I can't answer that yet: ${r.detail}`);
      return lines.join('\n');
    }
    lines.push(`Source: ${r.source.document.title}, effective ${r.source.effective_from}, snapshot ${r.source.sha256.slice(0, 12)}.`);
    lines.push(...r.derivation.map((d) => `  · ${d.detail}`));
    return lines.join('\n');
  }

  return {
    async ask(caseId, text) {
      consults.chatPush(caseId, { role: 'user', text });
      const grounded = await answer(caseId, text);
      // Cypher results and real-payer PA resolutions are verbatim data; the
      // LLM never rephrases them.
      const isRealPa = pa && REAL_PAYERS.some(([re]) => re.test(text))
        && (/\b(\d{5}|\d{4}[A-Z]|[A-Z]\d{4})\b/i.test(text)
          || Object.values(PROCEDURES).some((p) => text.toLowerCase().includes(p.short.toLowerCase())));
      const final = (CYPHER_START.test(text.trim()) || isRealPa) ? grounded : await llm.prose({
        purpose: 'chat', caseId,
        system: 'You are the chat surface of a prior-auth copilot. Rephrase the grounded answer conversationally for a clinician. You may ONLY use the facts, numbers, and lines provided — never add clinical or payer claims. Keep any bullet lines intact.',
        prompt: `Doctor asked: "${text}"\nGrounded answer to convey verbatim in substance:\n${grounded}`,
        fallbackText: grounded,
        maxTokens: 500,
      });
      return consults.chatPush(caseId, { role: 'agent', kind: 'qa', text: final });
    },
  };
}
