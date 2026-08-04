// Content-addressed snapshot store: every ingested document is frozen under
// its own sha256 before anything reads it. Parsers run on snapshots, never on
// the live web, so every fact in the graph traces to exact bytes on disk.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function createSnapshotStore(dir) {
  mkdirSync(dir, { recursive: true });

  return {
    /** Save bytes; returns {sha256, path, fetched_at}. Idempotent by content. */
    save(bytes, meta = {}) {
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const path = join(dir, sha256);
      if (!existsSync(path)) writeFileSync(path, bytes);
      const rec = { sha256, path, fetched_at: new Date().toISOString(), ...meta };
      writeFileSync(`${path}.meta.json`, JSON.stringify(rec, null, 2));
      return rec;
    },
    read(sha256) {
      return readFileSync(join(dir, sha256));
    },
    meta(sha256) {
      return JSON.parse(readFileSync(join(dir, `${sha256}.meta.json`), 'utf8'));
    },
  };
}

export async function fetchBytes(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) precedent-pa-graph/1.0' },
  });
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
