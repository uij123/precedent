// Local inbox — fallback when no email API key is configured. Messages land
// in an in-memory inbox (shown live in the UI's inbox panel) and are written
// as .eml files to var/outbox/ so there is a real artifact on disk.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { id, nowIso } from '../../util.js';

export function createLocalEmail({ outDir }) {
  mkdirSync(outDir, { recursive: true });
  const inbox = [];
  const handlers = new Set();

  return {
    mode: 'local-inbox',
    async send({ to, from, subject, text, attachments = [] }) {
      const msg = { id: id('eml'), to, from, subject, text, attachments: attachments.map((a) => a.filename), ts: nowIso() };
      inbox.push(msg);
      const head = [`From: ${from}`, `To: ${to}`, `Subject: ${subject}`, `Date: ${new Date().toUTCString()}`];
      let eml;
      if (attachments.length) {
        // proper multipart MIME so the .eml opens with its PDFs in any mail app
        const boundary = `----=_precedent_${msg.id}`;
        eml = [
          ...head, 'MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${boundary}"`, '',
          `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', '', text, '',
          ...attachments.flatMap((a) => [
            `--${boundary}`,
            `Content-Type: application/pdf; name="${a.filename}"`,
            'Content-Transfer-Encoding: base64',
            `Content-Disposition: attachment; filename="${a.filename}"`,
            '',
            a.content.replace(/(.{76})/g, '$1\r\n'),
            '',
          ]),
          `--${boundary}--`, '',
        ].join('\r\n');
      } else {
        eml = [...head, 'Content-Type: text/plain; charset=utf-8', '', text].join('\r\n');
      }
      writeFileSync(join(outDir, `${msg.id}.eml`), eml);
      for (const h of handlers) { try { h(msg); } catch { /* subscriber's problem */ } }
      return { id: msg.id, mode: 'local-inbox' };
    },
    subscribe(h) { handlers.add(h); return () => handlers.delete(h); },
    list(limit = 20) { return inbox.slice(-limit).reverse(); },
    count() { return inbox.length; },
  };
}
