// Token meter (spec §11B, required): every LLM call in the system passes
// through here. Real API calls record exact usage from the response; the
// deterministic fallback records estimated tokens, clearly labeled — the
// ROI counter is metered, not guessed.
import { MODEL_PRICE_PER_MTOKEN } from '../../config.js';

export function createMeter() {
  const calls = [];

  function usd(tokensIn, tokensOut) {
    return (tokensIn * MODEL_PRICE_PER_MTOKEN.input + tokensOut * MODEL_PRICE_PER_MTOKEN.output) / 1_000_000;
  }

  return {
    /** @param {{purpose:string, case_id?:string|null, tokens_in:number, tokens_out:number, estimated:boolean}} rec */
    record(rec) {
      const entry = { ...rec, usd: usd(rec.tokens_in, rec.tokens_out), ts: new Date().toISOString() };
      calls.push(entry);
      return entry;
    },
    /** Rough token estimate for fallback mode: ~4 chars per token. */
    estimateTokens(text) { return Math.ceil((text || '').length / 4); },
    totals(caseId = null) {
      const subset = caseId ? calls.filter((c) => c.case_id === caseId) : calls;
      const t = { calls: subset.length, tokens_in: 0, tokens_out: 0, usd: 0, estimated: false };
      for (const c of subset) {
        t.tokens_in += c.tokens_in; t.tokens_out += c.tokens_out; t.usd += c.usd;
        if (c.estimated) t.estimated = true;
      }
      return t;
    },
    receipt(caseId) {
      return calls.filter((c) => c.case_id === caseId)
        .map(({ purpose, tokens_in, tokens_out, usd: u, estimated }) => ({ purpose, tokens_in, tokens_out, usd: u, estimated }));
    },
    all: () => [...calls],
  };
}
