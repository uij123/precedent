// Bus adapter seam (spec §1.5): wire the real LaserData SDK first; fall back
// to the in-memory bus only if the service is unreachable.
import { createLocalBus } from './local.js';
import { report } from '../status.js';

export const TOPICS = ['consult.utterances', 'network.events', 'payer.verdicts', 'case.lifecycle'];

export async function createBus(config) {
  if (config.forceLocal.includes('bus')) {
    report('LaserData', { mode: 'local-fallback', detail: 'forced by FORCE_LOCAL' });
    return createLocalBus();
  }
  try {
    const { createLaserBus } = await import('./laserdata.js');
    const bus = await withTimeout(
      createLaserBus({ connectionString: config.laserConnectionString, stream: config.laserStream, topics: TOPICS }),
      5000,
    );
    report('LaserData', { mode: 'live', detail: `${config.laserConnectionString} stream=${config.laserStream}` });
    return bus;
  } catch (e) {
    report('LaserData', { mode: 'local-fallback', detail: e.message.slice(0, 120) });
    return createLocalBus();
  }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms}ms`)), ms)),
  ]);
}
