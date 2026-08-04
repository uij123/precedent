// Loader: canonical rulesets + IMR aggregates into FalkorDB, in a SEPARATE
// graph ("pa_california") from the synthetic demo graph. Idempotent: MERGE by
// natural keys; re-running the same ruleset changes nothing. Every edge
// carries the snapshot sha + effective date it came from.
import { FalkorDB } from 'falkordb';

export async function openPaGraph(url = process.env.FALKORDB_URL || 'redis://127.0.0.1:6379') {
  const u = new URL(url);
  const db = await FalkorDB.connect({ socket: { host: u.hostname, port: Number(u.port) || 6379 } });
  const graph = db.selectGraph('pa_california');
  const q = async (cypher, params) => (await graph.query(cypher, params ? { params } : undefined)).data || [];
  return { db, q, close: () => db.close() };
}

export async function loadRuleset(q, rs) {
  await q('MERGE (p:PAPayer {id: $pid}) SET p.name = $name', { pid: rs.payer_id, name: rs.payer_name });
  await q(
    `MATCH (p:PAPayer {id: $pid})
     MERGE (l:CoverageLine {id: $lid}) SET l.lob = $lob
     MERGE (p)-[:HAS_LINE]->(l)`,
    { pid: rs.payer_id, lid: `${rs.payer_id}:${rs.lob}`, lob: rs.lob });
  await q(
    `MERGE (s:SourceSnapshot {sha: $sha})
     SET s.url = $url, s.fetched_at = $fetched, s.effective_from = $eff, s.source_id = $sid, s.title = $title`,
    { sha: rs.sha256, url: rs.document?.url, fetched: rs.fetched_at, eff: rs.effective_from, sid: rs.source_id, title: rs.document?.title });

  let codeEdges = 0;
  for (const r of rs.rules) {
    if (r.kind === 'code') {
      await q(
        `MATCH (l:CoverageLine {id: $lid})
         MERGE (pol:PAPolicy {name: $policy, line_id: $lid})
         MERGE (l)-[:HAS_POLICY]->(pol)`,
        { lid: `${rs.payer_id}:${rs.lob}`, policy: r.policy });
      for (const code of r.codes) {
        await q(
          `MATCH (pol:PAPolicy {name: $policy, line_id: $lid})
           MERGE (c:PACode {code: $code})
           MERGE (pol)-[e:REQUIRES_AUTH]->(c)
           SET e.requirement = $req, e.effective_from = $eff, e.source_sha = $sha`,
          { policy: r.policy, lid: `${rs.payer_id}:${rs.lob}`, code, req: r.requirement, eff: rs.effective_from, sha: rs.sha256 });
        codeEdges += 1;
      }
    } else if (r.kind === 'category') {
      await q(
        `MATCH (l:CoverageLine {id: $lid})
         MERGE (cat:PACategory {key: $key, line_id: $lid})
         SET cat.label = $policy, cat.delegate = $delegate
         MERGE (l)-[e:DELEGATES]->(cat)
         SET e.effective_from = $eff, e.source_sha = $sha`,
        { lid: `${rs.payer_id}:${rs.lob}`, key: r.category_key, policy: r.policy, delegate: r.delegate, eff: rs.effective_from, sha: rs.sha256 });
    }
  }
  return { codeEdges };
}

export async function loadImr(q, agg) {
  for (const c of agg.categories) {
    await q(
      `MERGE (t:IMRCategory {category: $cat})
       SET t.total = $total, t.upheld = $upheld, t.overturned = $overturned, t.overturn_rate = $rate`,
      { cat: c.category, total: c.total, upheld: c.upheld, overturned: c.overturned, rate: c.overturn_rate });
  }
  return { categories: agg.categories.length, rows: agg.rows };
}
