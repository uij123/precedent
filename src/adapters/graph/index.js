// Graph adapter seam (spec §1.5): real FalkorDB first, in-memory twin as the
// emergency fallback. Both share the pure learning rule in core/learn.js.
import { createLocalGraph } from './local.js';
import { report } from '../status.js';

export async function createGraph(config) {
  if (config.forceLocal.includes('graph')) {
    report('FalkorDB', { mode: 'local-fallback', detail: 'forced by FORCE_LOCAL' });
    return createLocalGraph();
  }
  try {
    const { createFalkorGraph } = await import('./falkordb.js');
    const g = await withTimeout(createFalkorGraph({ url: config.falkordbUrl, graphName: config.falkordbGraph }), 5000);
    report('FalkorDB', { mode: 'live', detail: `${config.falkordbUrl} graph=${config.falkordbGraph}` });
    return g;
  } catch (e) {
    report('FalkorDB', { mode: 'local-fallback', detail: e.message.slice(0, 120) });
    return createLocalGraph();
  }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms}ms`)), ms)),
  ]);
}
