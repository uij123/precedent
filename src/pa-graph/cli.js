// CLI for the California PA graph.
//   node src/pa-graph/cli.js ingest blueshield-commercial-pa-list
//   node src/pa-graph/cli.js ingest dmhc-imr-determinations
//   node src/pa-graph/cli.js resolve <payer> <lob> <code> [asOf]
// Ingest: fetch → snapshot → parse → canonical JSON (data/pa/) → FalkorDB.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSnapshotStore, fetchBytes } from './snapshot.js';
import { parseBscList } from './parse-bsc-list.js';
import { parseUhcList } from './parse-uhc-list.js';
import { parseHnPage } from './parse-hn-page.js';
import { aggregateImr } from './imr.js';
import { openPaGraph, loadRuleset, loadImr } from './load-graph.js';
import { resolve as paResolve } from './resolve.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA_DIR = join(root, 'data', 'pa');
const SNAP_DIR = join(root, 'var', 'snapshots');
const registry = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'sources.json'), 'utf8'));

export function loadRulesets(dir = DATA_DIR) {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json') && !f.startsWith('imr'))
      .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
      .filter((r) => r.rules);
  } catch { return []; }
}

async function ingest(sourceId) {
  const src = registry.sources.find((s) => s.id === sourceId);
  if (!src) throw new Error(`unknown source ${sourceId}; known: ${registry.sources.map((s) => s.id).join(', ')}`);
  const store = createSnapshotStore(SNAP_DIR);
  mkdirSync(DATA_DIR, { recursive: true });

  console.log(`[fetch] ${src.url}`);
  const bytes = await fetchBytes(src.url);
  const snap = store.save(bytes, { url: src.url, source_id: src.id });
  console.log(`[snapshot] sha256 ${snap.sha256.slice(0, 16)}… (${bytes.length} bytes)`);

  if (src.parser === 'bsc-list' || src.parser === 'uhc-list') {
    // import the lib file directly: the package index self-runs demo code under ESM
    const { default: pdf } = await import('pdf-parse/lib/pdf-parse.js');
    const parsed = await pdf(bytes);
    const parse = src.parser === 'uhc-list' ? parseUhcList : parseBscList;
    const rs = parse(parsed.text, { source: src, sha256: snap.sha256, fetched_at: snap.fetched_at });
    if (!rs.effective_from) throw new Error('could not read the effective date from the document');
    const out = join(DATA_DIR, `${src.id}.${rs.effective_from}.json`);
    writeFileSync(out, JSON.stringify(rs, null, 2));
    console.log(`[parse] ${rs.stats.code_rules} code policies · ${rs.stats.category_rules} delegated programs · ${rs.stats.distinct_codes} distinct codes`);
    console.log(`[canonical] ${out}`);
    try {
      const g = await openPaGraph();
      const res = await loadRuleset(g.q, rs);
      await g.close();
      console.log(`[graph] pa_california loaded: ${res.codeEdges} REQUIRES_AUTH edges`);
    } catch (e) {
      console.log(`[graph] skipped (FalkorDB unavailable: ${e.message}) — canonical JSON still written`);
    }
    return;
  }

  if (src.parser === 'hn-print') {
    const rs = parseHnPage(bytes.toString('utf8'), { source: src, sha256: snap.sha256, fetched_at: snap.fetched_at });
    if (!rs.effective_from) throw new Error('could not read the effective date from the page');
    const out = join(DATA_DIR, `${src.id}.${rs.effective_from}.json`);
    writeFileSync(out, JSON.stringify(rs, null, 2));
    console.log(`[parse] ${rs.stats.service_rules} named services · ${rs.stats.category_rules} delegated programs · ${rs.stats.distinct_codes} explicit codes`);
    console.log(`[canonical] ${out}`);
    try {
      const g = await openPaGraph();
      await loadRuleset(g.q, rs);
      await g.close();
      console.log('[graph] pa_california loaded');
    } catch (e) {
      console.log(`[graph] skipped (FalkorDB unavailable: ${e.message})`);
    }
    return;
  }

  if (src.parser === 'imr-csv') {
    const csvPath = join(SNAP_DIR, snap.sha256);
    console.log('[aggregate] streaming CSV…');
    const agg = await aggregateImr(csvPath);
    agg.sha256 = snap.sha256;
    agg.fetched_at = snap.fetched_at;
    const out = join(DATA_DIR, 'imr-aggregates.json');
    writeFileSync(out, JSON.stringify(agg, null, 2));
    console.log(`[aggregate] ${agg.rows} determinations → ${agg.categories.length} treatment categories`);
    console.log(`[canonical] ${out}`);
    try {
      const g = await openPaGraph();
      const res = await loadImr(g.q, agg);
      await g.close();
      console.log(`[graph] pa_california loaded: ${res.categories} IMR category nodes`);
    } catch (e) {
      console.log(`[graph] skipped (FalkorDB unavailable: ${e.message})`);
    }
    return;
  }
  throw new Error(`no parser wired for ${src.parser}`);
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'ingest') {
  await ingest(args[0]);
} else if (cmd === 'resolve') {
  const [payer, lob, code, asOf] = args;
  const rulesets = loadRulesets();
  const res = paResolve(rulesets, { payer, lob, code, asOf: asOf || new Date().toISOString().slice(0, 10) });
  console.log(JSON.stringify(res, null, 2));
} else if (cmd !== undefined) {
  console.log('usage: cli.js ingest <source-id> | resolve <payer> <lob> <code> [asOf]');
}
