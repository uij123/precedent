// Email seam with built-in exactly-once behavior: chains pass an idempotency
// key; a duplicate key never sends a second message (spec §9, tested by the
// execution harness).
import { createLocalEmail } from './local.js';
import { report } from '../status.js';

export async function createEmail(config, { outDir }) {
  let impl;
  if (config.resendApiKey && !config.forceLocal.includes('email')) {
    const { createResendEmail } = await import('./resend.js');
    impl = createResendEmail({ apiKey: config.resendApiKey });
    report('Email', { mode: 'live', detail: `resend → ${config.emailTo}` });
  } else {
    impl = createLocalEmail({ outDir });
    report('Email', { mode: 'local-fallback', detail: 'local inbox + .eml files (set RESEND_API_KEY to go live)' });
  }

  const seenKeys = new Set();
  return {
    mode: impl.mode,
    /** @param {{key:string, to?:string, subject:string, text:string, attachments?:Array<{filename:string, content:string}>}} args
        attachments carry base64 content; both backends accept them. */
    async send({ key, to = config.emailTo, subject, text, attachments }) {
      if (key) {
        if (seenKeys.has(key)) return { duplicate: true };
        seenKeys.add(key);
      }
      try {
        return await impl.send({ to, from: config.emailFrom, subject, text, attachments });
      } catch (e) {
        if (key) seenKeys.delete(key); // allow retry after a genuine failure
        throw e;
      }
    },
    subscribe: (h) => impl.subscribe(h),
    list: (n) => impl.list(n),
    count: () => impl.count(),
  };
}
