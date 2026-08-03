// Real LLM path: Claude via the official Anthropic SDK. Used for the
// extraction agent and for agent/debate prose. Structured outputs constrain
// extraction to the fact enum; the deterministic core stays LLM-free.
import Anthropic from '@anthropic-ai/sdk';

const FACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['facts'],
  properties: {
    facts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'value'],
        properties: {
          type: {
            type: 'string',
            enum: ['therapy_weeks', 'therapy_provider', 'pt_notes_available', 'redflags', 'imaging_intent', 'payer_mention'],
          },
          value: { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] },
        },
      },
    },
  },
};

export function createAnthropicLLM({ apiKey, model }) {
  const client = new Anthropic({ apiKey });
  // `effort` is unsupported on Haiku 4.5 and older (400) — send it only where valid.
  const supportsEffort = !/haiku|-4-5|-4-0|3-5/.test(model);
  const outputConfig = (extra = {}) => (supportsEffort ? { effort: 'low', ...extra } : { ...extra });

  return {
    async extractFacts(utterance, ctx) {
      const system = [
        'You are the extraction agent of a prior-authorization copilot for lumbar-spine MRI consults.',
        'Turn ONE utterance into structured facts. Emit ONLY facts explicitly supported by the utterance (with the previous utterance as context). If nothing is stated, return an empty list — never guess.',
        `Consult date: ${ctx.consultDate.toISOString().slice(0, 10)}. Compute therapy_weeks as whole weeks elapsed (e.g. "physio since mid-June" → weeks between June 15 and the consult date).`,
        'payer_mention values must be one of: bluepeak (BluePeak Health), meridian (Meridian Care), calwest (CalWest Mutual).',
        'therapy_provider only when a SPECIFIC provider is named (e.g. "Dr. Rossi", "the PT clinic on 5th") — never the generic modality.',
        'redflags: "present" if red-flag symptoms are reported (saddle anesthesia, bladder/bowel dysfunction, cancer history, fever/weight loss); "absent" if screening questions were asked and answered negative. Do not emit redflags otherwise.',
        'imaging_intent: true only when the DOCTOR commits to ordering the MRI.',
      ].join('\n');
      const prompt = `Previous utterance (context): ${ctx.prev ? `[${ctx.prev.speaker}] ${ctx.prev.text}` : '(none)'}\nUtterance: [${utterance.speaker}] ${utterance.text}`;

      const response = await client.messages.create({
        model,
        max_tokens: 1024,
        output_config: outputConfig({ format: { type: 'json_schema', schema: FACT_SCHEMA } }),
        system,
        messages: [{ role: 'user', content: prompt }],
      });
      if (response.stop_reason === 'refusal') return { facts: [], usage: response.usage };
      const text = response.content.find((b) => b.type === 'text')?.text || '{"facts":[]}';
      let facts = [];
      try { facts = JSON.parse(text).facts || []; } catch { facts = []; }
      return { facts, usage: response.usage };
    },

    /** Free-prose generation for agent debate / chat, grounded by the caller. */
    async generateText({ system, prompt, maxTokens = 700 }) {
      const request = {
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: prompt }],
      };
      if (supportsEffort) request.output_config = outputConfig();
      const response = await client.messages.create(request);
      if (response.stop_reason === 'refusal') return { text: null, usage: response.usage };
      return { text: response.content.find((b) => b.type === 'text')?.text || null, usage: response.usage };
    },
  };
}
