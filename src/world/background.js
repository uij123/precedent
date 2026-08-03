// Background world generator (spec §3.3): synthetic PA events from ~8 fictional
// clinics, outcomes computed by the same ground-truth verdict simulator. These
// events are the graph's main learning diet. Start/stop/rate from the dashboard.
import { makeRng } from '../rng.js';
import { verdict } from '../domain/verdict-sim.js';
import { PAYER_IDS, PROCEDURES } from '../domain/payers.js';
import { id, nowIso } from '../util.js';

const PROCEDURE_CPTS = Object.keys(PROCEDURES);

const CLINICS = Array.from({ length: 8 }, (_, i) => `clinic-${String(i + 1).padStart(2, '0')}`);

export function createBackgroundWorld({ publish, seed, minMs, maxMs }) {
  const rng = makeRng(seed);
  let timer = null;
  let running = false;
  let range = { minMs, maxMs };
  let emitted = 0;

  function randomPacket() {
    return {
      therapy_weeks: rng.pick([0, 1, 2, 3, 3, 4, 4, 5, 6, 6, 7, 8, 10]),
      pt_notes: rng.chance(0.4),
      redflag_screen: rng.chance(0.7),
      order_form: rng.chance(0.5),
      dx: rng.chance(0.9) ? 'M54.5' : 'M54.4',
      redflags_present: rng.chance(0.03),
    };
  }

  async function tick() {
    const payer_id = rng.pick(PAYER_IDS);
    const packet = randomPacket();
    const v = verdict(packet, payer_id);
    const event = {
      event_id: id('ne'),
      clinic_id: rng.pick(CLINICS),
      payer_id,
      cpt: rng.pick(PROCEDURE_CPTS),
      packet,
      outcome: v.outcome,
      reason_codes: v.reason_codes,
      reason_params: v.reason_params,
      ts: nowIso(),
    };
    emitted += 1;
    await publish('network.events', event);
    schedule();
  }

  function schedule() {
    if (!running) return;
    const delay = range.minMs + Math.floor(rng.next() * Math.max(1, range.maxMs - range.minMs));
    timer = setTimeout(() => tick().catch((e) => console.error('[background]', e.message)), delay);
  }

  return {
    start() { if (running) return; running = true; schedule(); },
    stop() { running = false; if (timer) clearTimeout(timer); timer = null; },
    setRate(minMs2, maxMs2) { range = { minMs: minMs2, maxMs: maxMs2 }; },
    /** Emit n events immediately (demo warm-up / tests). */
    async burst(n) { for (let i = 0; i < n; i++) { running = true; await tickOnce(); } running = !!timer; },
    status: () => ({ running, emitted, ...range }),
  };

  async function tickOnce() {
    const wasRunning = running;
    running = false; // prevent tick() from rescheduling
    await tick();
    running = wasRunning;
  }
}
