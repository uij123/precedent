// LLM adapter seam. With ANTHROPIC_API_KEY: real Claude for extraction and
// agent prose, exact token metering from API usage. Without: the deterministic
// rule engine extracts, services fall back to template prose, and the meter
// records estimates (labeled). Either way the decision core never sees an LLM.
import { extractFacts as ruleExtract } from '../../core/extract-rules.js';
import { report } from '../status.js';

export async function createLLM(config, meter) {
  let engine = null;
  let mode = 'deterministic';

  if (config.openrouterApiKey && !config.forceLocal.includes('llm')) {
    try {
      const { createOpenRouterLLM } = await import('./openrouter.js');
      engine = createOpenRouterLLM({ apiKey: config.openrouterApiKey, model: config.openrouterModel });
      mode = 'openrouter';
      report('LLM', { mode: 'live', detail: `openrouter · ${config.openrouterModel}` });
    } catch (e) {
      report('LLM', { mode: 'deterministic-fallback', detail: e.message.slice(0, 120) });
    }
  } else if (config.anthropicApiKey && !config.forceLocal.includes('llm')) {
    try {
      const { createAnthropicLLM } = await import('./anthropic.js');
      engine = createAnthropicLLM({ apiKey: config.anthropicApiKey, model: config.anthropicModel });
      mode = 'anthropic';
      report('LLM', { mode: 'live', detail: `claude · ${config.anthropicModel}` });
    } catch (e) {
      report('LLM', { mode: 'deterministic-fallback', detail: e.message.slice(0, 120) });
    }
  } else {
    report('LLM', {
      mode: 'deterministic-fallback',
      detail: 'no LLM key — rule engine + template prose (set OPENROUTER_API_KEY or ANTHROPIC_API_KEY)',
    });
  }

  return {
    mode,

    async extractFacts(utterance, ctx, caseId = null) {
      if (engine) {
        try {
          const { facts, usage } = await engine.extractFacts(utterance, ctx);
          meter.record({
            purpose: 'extraction', case_id: caseId,
            tokens_in: usage.input_tokens, tokens_out: usage.output_tokens, estimated: false,
          });
          return facts;
        } catch (e) {
          console.error('[llm] extraction failed, using rule engine:', e.message);
        }
      }
      const facts = ruleExtract(utterance, ctx);
      meter.record({
        purpose: 'extraction', case_id: caseId,
        tokens_in: meter.estimateTokens(utterance.text) + 220, // prompt overhead equivalent
        tokens_out: meter.estimateTokens(JSON.stringify(facts)),
        estimated: true,
      });
      return facts;
    },

    /**
     * Prose for agents/chat. `fallbackText` is the deterministic template the
     * caller composed from graph facts — used verbatim when no LLM is wired,
     * and offered to Claude as grounding when one is.
     */
    async prose({ purpose, caseId = null, system, prompt, fallbackText, maxTokens = 700 }) {
      if (engine) {
        try {
          const { text, usage } = await engine.generateText({ system, prompt, maxTokens });
          meter.record({
            purpose, case_id: caseId,
            tokens_in: usage.input_tokens, tokens_out: usage.output_tokens, estimated: false,
          });
          if (text) return text;
        } catch (e) {
          console.error(`[llm] ${purpose} failed, using template:`, e.message);
        }
      }
      meter.record({
        purpose, case_id: caseId,
        tokens_in: meter.estimateTokens(`${system || ''}${prompt || ''}`),
        tokens_out: meter.estimateTokens(fallbackText),
        estimated: true,
      });
      return fallbackText;
    },
  };
}
