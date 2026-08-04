// DMHC Independent Medical Review outcomes: every appealed denial in
// California since 2001. This trend file is payer-anonymous, so aggregates
// are state-wide per treatment category — framed exactly that way, never as
// per-payer facts. Quote-aware CSV parsing, streaming, no dependencies.
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

/** Minimal RFC-4180 line parser (fields may be quoted and contain commas). */
export function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') { inQ = false; } else cur += ch;
    } else if (ch === '"') { inQ = true; } else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Stream the IMR CSV into aggregates:
 * by treatment category × year → { upheld, overturned, total } + overall.
 * "Overturned" includes both flavors DMHC records (decision reversed, and
 * plan reversed on its own after IMR was opened).
 */
export async function aggregateImr(csvPath) {
  const rl = createInterface({ input: createReadStream(csvPath), crlfDelay: Infinity });
  let header = null;
  let idx = {};
  const byCategory = new Map();
  let rows = 0;
  let pending = '';

  const record = (fields) => {
    rows += 1;
    const cat = fields[idx.TreatmentCategory] || 'Unknown';
    const year = Number(fields[idx.ReportYear]) || 0;
    const det = (fields[idx.Determination] || '').toLowerCase();
    const overturned = det.includes('overturned') || det.includes('reversed');
    const key = cat;
    if (!byCategory.has(key)) byCategory.set(key, { category: cat, total: 0, upheld: 0, overturned: 0, years: {} });
    const c = byCategory.get(key);
    c.total += 1;
    if (overturned) c.overturned += 1; else c.upheld += 1;
    const y = (c.years[year] ||= { total: 0, overturned: 0 });
    y.total += 1;
    if (overturned) y.overturned += 1;
  };

  for await (const raw of rl) {
    // Findings fields contain embedded newlines inside quotes; stitch until
    // the quote count balances.
    const line = pending ? `${pending}\n${raw}` : raw;
    const quotes = (line.match(/"/g) || []).length;
    if (quotes % 2 !== 0) { pending = line; continue; }
    pending = '';
    if (!header) {
      header = parseCsvLine(line);
      idx = Object.fromEntries(header.map((h, i) => [h, i]));
      continue;
    }
    if (!line.trim()) continue;
    record(parseCsvLine(line));
  }

  const categories = [...byCategory.values()].sort((a, b) => b.total - a.total);
  for (const c of categories) c.overturn_rate = c.total ? +(c.overturned / c.total).toFixed(4) : 0;
  return {
    source_id: 'dmhc-imr-determinations',
    rows,
    note: 'State-wide DMHC IMR outcomes; the public trend file does not name plans.',
    categories,
  };
}
