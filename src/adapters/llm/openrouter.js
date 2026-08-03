// OpenRouter engine — user-selected cheap-model path for extraction and agent
// prose (OpenAI-compatible API, plain fetch, no extra deps). Same contract as
// the Anthropic engine; the deterministic rule engine remains the fallback.
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

export function createOpenRouterLLM({ apiKey, model }) {
  async function complete({ system, prompt, maxTokens, jsonSchema }) {
    const body = {
      model,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    };
    if (jsonSchema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: 'facts', strict: true, schema: jsonSchema },
      };
    }
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'x-title': 'Precedent (hackathon demo)',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`openrouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    if (data.error) throw new Error(`openrouter: ${JSON.stringify(data.error).slice(0, 200)}`);
    return {
      text: data.choices?.[0]?.message?.content || '',
      usage: {
        input_tokens: data.usage?.prompt_tokens ?? 0,
        output_tokens: data.usage?.completion_tokens ?? 0,
      },
    };
  }

  return {
    async extractFacts(utterance, ctx) {
      const system = [
        'You are the extraction agent of a prior-authorization copilot for lumbar-spine MRI consults.',
        'Turn ONE utterance into structured facts. Emit ONLY facts explicitly supported by the utterance (with the previous utterance as context). If nothing is stated, return {"facts":[]} — never guess.',
        `Consult date: ${ctx.consultDate.toISOString().slice(0, 10)}. Compute therapy_weeks as whole weeks elapsed (e.g. "physio since mid-June" → weeks between June 15 and the consult date).`,
        'payer_mention values must be one of: bluepeak (BluePeak Health), meridian (Meridian Care), calwest (CalWest Mutual).',
        'therapy_provider only when a SPECIFIC provider is named (e.g. "Dr. Rossi", "the PT clinic on 5th") — never the generic modality.',
        'redflags: "present" if red-flag symptoms are reported (saddle anesthesia, bladder/bowel dysfunction, cancer history, fever/weight loss); "absent" if screening questions were asked and answered negative. Do not emit redflags otherwise.',
        'imaging_intent: true only when the DOCTOR commits to ordering the MRI.',
        'Respond with JSON only.',
      ].join('\n');
      const prompt = `Previous utterance (context): ${ctx.prev ? `[${ctx.prev.speaker}] ${ctx.prev.text}` : '(none)'}\nUtterance: [${utterance.speaker}] ${utterance.text}`;
      const { text, usage } = await complete({ system, prompt, maxTokens: 1024, jsonSchema: FACT_SCHEMA });
      let facts = [];
      try { facts = JSON.parse(text.replace(/^```(json)?|```$/g, '').trim()).facts || []; } catch { facts = []; }
      return { facts, usage };
    },

    async generateText({ system, prompt, maxTokens = 700 }) {
      const { text, usage } = await complete({ system, prompt, maxTokens });
      return { text: text || null, usage };
    },
  };
}
