// Ingest workers (spec §4): consume the streams, write the graph. The memory
// compounds here — every network event and every verdict flows through these
// two subscriptions into FalkorDB.

export function startIngest({ bus, graph, onLearned }) {
  const unsubs = [];

  // Learning is read-modify-write against the graph; concurrent events would
  // lose increments. Single-writer discipline: all learning is serialized.
  let queue = Promise.resolve();
  const serialize = (fn) => {
    const run = queue.then(fn);
    queue = run.catch((e) => console.error('[ingest]', e.message));
    return run;
  };

  // Background world + mirrored own outcomes. Mirrored events (mirrored_from)
  // were already learned via payer.verdicts — show them, don't double-count.
  unsubs.push(bus.subscribe('network.events', (evt) => serialize(async () => {
    if (evt.mirrored_from) return;
    const codes = await graph.learnFromOutcome({
      kind: 'network',
      source_id: evt.event_id,
      clinic_id: evt.clinic_id,
      payer_id: evt.payer_id,
      cpt: evt.cpt,
      packet: evt.packet,
      outcome: evt.outcome,
      reason_codes: evt.reason_codes,
      reason_params: evt.reason_params || {},
      ts: evt.ts,
    });
    if (codes.length && onLearned) onLearned({ payer_id: evt.payer_id, codes, source: 'network' });
  })));

  // Verdicts on OUR submissions.
  unsubs.push(bus.subscribe('payer.verdicts', (evt) => serialize(async () => {
    const codes = await graph.learnFromOutcome({
      kind: 'submission',
      source_id: evt.submission_id,
      payer_id: evt.payer_id,
      cpt: evt.cpt,
      packet: evt.packet, // chains attach the submitted packet so learning sees it
      outcome: evt.outcome,
      reason_codes: evt.reason_codes,
      reason_params: evt.reason_params || {},
      ts: evt.ts,
    });
    if (codes.length && onLearned) onLearned({ payer_id: evt.payer_id, codes, source: 'submission' });
  })));

  return () => unsubs.forEach((u) => u());
}
