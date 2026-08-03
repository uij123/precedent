// Payer simulator service (spec §10): a tiny HTTP service on its own port.
// POST /payer/{id}/submit with packet JSON → applies ground-truth rules →
// returns the verdict after a fixed processing delay (20s demo, 3s fast).
// This service is the ONLY place ground-truth rules are exercised for real
// submissions; the app never imports verdict-sim outside the simulator+world.
import { createServer } from 'node:http';
import { verdict } from '../domain/verdict-sim.js';
import { PAYERS } from '../domain/payers.js';
import { readJson, sendJson, nowIso, sleep } from '../util.js';

export function createPayerSim({ port, delayMs }) {
  let delay = delayMs;
  let received = 0;

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://localhost:${port}`);
      const parts = url.pathname.split('/').filter(Boolean);

      if (req.method === 'GET' && url.pathname === '/health') {
        return sendJson(res, 200, { ok: true, delay_ms: delay, received });
      }
      if (req.method === 'POST' && url.pathname === '/config') {
        const body = await readJson(req);
        if (Number.isFinite(body.delay_ms)) delay = body.delay_ms;
        return sendJson(res, 200, { ok: true, delay_ms: delay });
      }
      if (req.method === 'POST' && parts[0] === 'payer' && parts[2] === 'submit') {
        const payerId = parts[1];
        if (!PAYERS[payerId]) return sendJson(res, 404, { error: `unknown payer ${payerId}` });
        const body = await readJson(req);
        if (!body.packet) return sendJson(res, 400, { error: 'missing packet' });
        received += 1;
        const delayParam = url.searchParams.get('delay_ms');
        const effectiveDelay = delayParam !== null && Number.isFinite(Number(delayParam))
          ? Number(delayParam) : delay;
        const v = verdict(body.packet, payerId); // decided now; withheld to simulate processing
        await sleep(effectiveDelay);
        return sendJson(res, 200, {
          submission_id: body.submission_id || null,
          payer_id: payerId,
          outcome: v.outcome,
          reason_codes: v.reason_codes,
          reason_params: v.reason_params,
          decided_at: nowIso(),
        });
      }
      sendJson(res, 404, { error: 'not found' });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
  });

  return {
    listen: () => new Promise((resolve) => server.listen(port, () => resolve(server.address().port))),
    close: () => new Promise((resolve) => server.close(resolve)),
    setDelay: (ms) => { delay = ms; },
    getDelay: () => delay,
    port: () => server.address()?.port ?? port,
  };
}
