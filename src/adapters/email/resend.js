// Real email via Resend's HTTP API — a real message to a real inbox, live on
// the projector (spec §9). Wired when RESEND_API_KEY is set.
import { id, nowIso } from '../../util.js';

export function createResendEmail({ apiKey }) {
  const sent = [];
  const handlers = new Set();

  return {
    mode: 'resend',
    async send({ to, from, subject, text, attachments = [] }) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          from, to: [to], subject, text,
          ...(attachments.length ? { attachments: attachments.map((a) => ({ filename: a.filename, content: a.content })) } : {}),
        }),
      });
      if (!res.ok) throw new Error(`resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const body = await res.json();
      const msg = { id: body.id || id('eml'), to, from, subject, text, attachments: attachments.map((a) => a.filename), ts: nowIso() };
      sent.push(msg);
      for (const h of handlers) { try { h(msg); } catch { /* ignore */ } }
      return { id: msg.id, mode: 'resend' };
    },
    subscribe(h) { handlers.add(h); return () => handlers.delete(h); },
    list(limit = 20) { return sent.slice(-limit).reverse(); },
    count() { return sent.length; },
  };
}
