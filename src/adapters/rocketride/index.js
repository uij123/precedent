// RocketRide orchestration seam (spec §9): chains are named multi-step
// sequences, triggered with an idempotency key — a duplicate trigger with the
// same key must never run twice. Chain definitions are plain {name, run(ctx)}
// steps so they lift 1:1 into RocketRide pipeline definitions.
//
// LIVE WIRING (ROCKETRIDE_API_KEY set): the adapter authenticates the
// `rocketride` SDK client (WebSocket/DAP to api.rocketride.ai) and — the
// load-bearing part — every chain defined here is mirrored as a pipeline and
// VALIDATED SERVER-SIDE by RocketRide's pipeline engine at boot. Execution
// itself still runs on the local runner: per-run pipe execution (client.use/
// send, lane 'text') and deploy.* need the component-config vocabulary /
// account tier — confirm both at the sponsor table (see README).
import { report } from '../status.js';
import { nowIso } from '../../util.js';

export async function createChainRunner(config, { onStep } = {}) {
  let rocket = null;
  let account = null;
  const validated = new Map(); // chain name -> validation ok

  if (config.rocketrideApiKey && !config.forceLocal.includes('rocketride')) {
    try {
      const { RocketRideClient } = await import('rocketride');
      rocket = new RocketRideClient({
        auth: config.rocketrideApiKey,
        module: 'precedent',
        persist: true,
      });
      account = await rocket.connect(undefined, { timeout: 15000 });
      report('RocketRide', {
        mode: 'live',
        detail: `api.rocketride.ai · ${account.email || account.displayName || 'authenticated'} · chains validated server-side`,
      });
    } catch (e) {
      rocket = null;
      report('RocketRide', { mode: 'local-fallback', detail: `connect failed: ${e.message.slice(0, 100)}` });
    }
  } else {
    report('RocketRide', {
      mode: 'local-fallback',
      detail: 'local chain runner (set ROCKETRIDE_API_KEY in .env to go live)',
    });
  }

  const chains = new Map();  // name -> steps
  const executed = new Map(); // idempotency key -> run record
  const runs = [];

  // A chain, expressed as a RocketRide pipeline definition (webhook intake →
  // response ack, steps carried in the description/config). This is what gets
  // server-side validated, and what a deploy.add() would ship at the venue.
  function pipelineFor(name, steps) {
    return {
      description: `Precedent ${name}: ${steps.map((s) => s.name).join(' → ')}`,
      components: [
        { id: 'webhook_1', provider: 'webhook', name: `${name} trigger`, config: {}, input: [] },
        {
          id: 'response_1', provider: 'response', name: `${name} result`,
          config: { lanes: ['text'], steps: steps.map((s) => s.name) },
          input: [{ lane: 'text', from: 'webhook_1' }],
        },
      ],
      source: 'webhook_1',
      project_id: `precedent-${name}`,
    };
  }

  async function validateChain(name, steps) {
    if (!rocket) return;
    try {
      await rocket.validate({ pipeline: pipelineFor(name, steps) });
      validated.set(name, true);
      console.log(`[rocketride] ${name}: pipeline definition validated server-side ✓`);
    } catch (e) {
      validated.set(name, false);
      console.error(`[rocketride] ${name}: validation failed — ${e.message.slice(0, 120)}`);
    }
  }

  return {
    mode: rocket ? 'rocketride' : 'local',
    account: account ? { email: account.email, name: account.displayName, org: account.organization?.name } : null,
    validations: () => Object.fromEntries(validated),

    define(name, steps) {
      chains.set(name, steps);
      validateChain(name, steps); // fire-and-forget; badge/log reports result
    },

    /**
     * Trigger a chain. Idempotent: a second trigger with the same key is a
     * no-op that reports `duplicate` (spec §9, tested).
     */
    async trigger(name, { key, input }) {
      const steps = chains.get(name);
      if (!steps) throw new Error(`unknown chain ${name}`);
      if (executed.has(key)) return { status: 'duplicate', key, run: executed.get(key) };

      const run = { chain: name, key, started_at: nowIso(), steps: [], status: 'running' };
      executed.set(key, run);
      runs.push(run);

      const ctx = { input, key, results: {} };
      try {
        for (const step of steps) {
          const started = Date.now();
          const result = await step.run(ctx);
          ctx.results[step.name] = result;
          const rec = { step: step.name, ms: Date.now() - started, at: nowIso() };
          run.steps.push(rec);
          onStep?.({ chain: name, key, ...rec });
        }
        run.status = 'completed';
        run.finished_at = nowIso();
        return { status: 'completed', key, run, results: ctx.results };
      } catch (e) {
        run.status = 'failed';
        run.error = e.message;
        run.finished_at = nowIso();
        // A failed run may be retried with the same key.
        executed.delete(key);
        throw e;
      }
    },

    hasRun: (key) => executed.has(key),
    runs: (limit = 50) => runs.slice(-limit),
    async close() { try { await rocket?.disconnect(); } catch { /* shutdown */ } },
  };
}
