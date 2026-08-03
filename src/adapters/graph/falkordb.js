// FalkorDB graph memory — the veteran clerk. Cypher schema per spec §5:
// (Patient)-[:INSURED_BY]->(Payer)-[:REQUIRES]->(Requirement)
// (Consult)-[:ABOUT]->(Patient), (Consult)-[:YIELDED]->(Fact)
// (Submission)-[:TO]->(Payer), (Submission|NetworkEvent)-[:RESULTED_IN]->(Outcome)-[:BECAUSE]->(Requirement)
// (Requirement)-[:FOR_PROCEDURE]->(Procedure)
// Learning is the pure rule in core/learn.js; this adapter persists its output.
import { FalkorDB } from 'falkordb';
import { applyOutcome } from '../../core/learn.js';
import { PAYERS, PROCEDURE, PROCEDURES } from '../../domain/payers.js';

export async function createFalkorGraph({ url, graphName }) {
  const u = new URL(url);
  const db = await FalkorDB.connect({ socket: { host: u.hostname, port: Number(u.port) || 6379 } });
  let graph = db.selectGraph(graphName);

  const q = async (cypher, params) => (await graph.query(cypher, params ? { params } : undefined)).data || [];

  async function seed() {
    for (const proc of Object.values(PROCEDURES)) {
      await q('MERGE (proc:Procedure {cpt: $cpt}) SET proc.label = $label',
        { cpt: proc.cpt, label: proc.label });
    }
    for (const p of Object.values(PAYERS)) {
      await q('MERGE (payer:Payer {id: $id}) SET payer.name = $name', { id: p.id, name: p.name });
    }
  }
  await seed();

  function rowToReq(r) {
    return {
      code: r.code,
      params: r.params_json ? JSON.parse(r.params_json) : {},
      evidence_count: r.evidence_count ?? 0,
      confidence: r.confidence ?? 0,
      denied_at_max: r.denied_at_max ?? null,
      approved_at_min: r.approved_at_min ?? null,
      last_seen: r.last_seen ?? null,
    };
  }

  async function requirementsMap(payerId) {
    const rows = await q(
      `MATCH (:Payer {id: $pid})-[:REQUIRES]->(r:Requirement)
       RETURN r.code AS code, r.params_json AS params_json, r.evidence_count AS evidence_count,
              r.confidence AS confidence, r.denied_at_max AS denied_at_max,
              r.approved_at_min AS approved_at_min, r.last_seen AS last_seen`,
      { pid: payerId });
    return new Map(rows.map((r) => [r.code, rowToReq(r)]));
  }

  return {
    mode: 'falkordb',
    async init() {},
    async close() { await db.close(); },
    async resetAll() {
      try { await graph.delete(); } catch { /* graph may not exist yet */ }
      graph = db.selectGraph(graphName);
      await seed();
    },

    async ensurePatient(p) {
      await q(
        `MERGE (pt:Patient {id: $id}) SET pt.name = $name
         WITH pt MATCH (payer:Payer {id: $payer_id}) MERGE (pt)-[:INSURED_BY]->(payer)`,
        { id: p.id, name: p.name, payer_id: p.payer_id });
    },
    async getPatient(id) {
      const rows = await q(
        `MATCH (pt:Patient {id: $id}) OPTIONAL MATCH (pt)-[:INSURED_BY]->(payer:Payer)
         RETURN pt.id AS id, pt.name AS name, payer.id AS payer_id`, { id });
      return rows[0] || null;
    },
    async ensureConsult(c) {
      await q(
        `MERGE (co:Consult {id: $cid}) SET co.started_at = $ts
         WITH co MATCH (pt:Patient {id: $pid}) MERGE (co)-[:ABOUT]->(pt)`,
        { cid: c.consult_id, pid: c.patient_id, ts: c.started_at });
    },
    /** Transcript persistence — visits are reviewable across restarts. */
    async addUtterance(consultId, u) {
      await q(
        `MATCH (co:Consult {id: $cid})
         CREATE (co)-[:SAID]->(:Utterance {consult_id: $cid, seq: $seq, speaker: $sp, text: $tx, ts: $ts})`,
        { cid: consultId, seq: u.seq || 0, sp: u.speaker, tx: u.text, ts: u.ts });
    },
    async getUtterances(consultId) {
      const rows = await q(
        `MATCH (:Consult {id: $cid})-[:SAID]->(u:Utterance)
         RETURN u.seq AS seq, u.speaker AS speaker, u.text AS text, u.ts AS ts ORDER BY u.ts, u.seq`,
        { cid: consultId });
      return rows.map((r) => ({ consult_id: consultId, seq: r.seq, speaker: r.speaker, text: r.text, ts: r.ts }));
    },
    /** Chat persistence — the copilot conversation is part of the visit. */
    async addChatMessage(consultId, caseId, m) {
      await q(
        `MATCH (co:Consult {id: $cid})
         CREATE (co)-[:DISCUSSED]->(:ChatMessage {consult_id: $cid, case_id: $case, id: $mid,
           role: $role, kind: $kind, agent: $agent, text: $tx, data_json: $dj, ts: $ts})`,
        {
          cid: consultId, case: caseId, mid: m.id, role: m.role, kind: m.kind ?? null,
          agent: m.agent ?? null, tx: m.text || '', dj: m.data ? JSON.stringify(m.data) : null, ts: m.ts,
        });
    },
    async getChatMessages(consultId) {
      const rows = await q(
        `MATCH (:Consult {id: $cid})-[:DISCUSSED]->(m:ChatMessage)
         RETURN m.case_id AS case_id, m.id AS id, m.role AS role, m.kind AS kind,
                m.agent AS agent, m.text AS text, m.data_json AS data_json, m.ts AS ts
         ORDER BY m.ts`,
        { cid: consultId });
      return rows.map((r) => ({
        case_id: r.case_id, id: r.id, role: r.role, kind: r.kind ?? undefined,
        agent: r.agent ?? undefined, text: r.text, ts: r.ts,
        data: r.data_json ? JSON.parse(r.data_json) : undefined,
      }));
    },

    async listConsults(limit = 30) {
      const rows = await q(
        `MATCH (co:Consult)-[:ABOUT]->(pt:Patient)
         RETURN co.id AS consult_id, co.started_at AS started_at, pt.name AS patient_name, pt.payer_id AS payer_id
         ORDER BY co.started_at DESC LIMIT ${Number(limit)}`);
      return rows;
    },

    async addFact(consultId, f) {
      await q(
        `MATCH (co:Consult {id: $cid})
         CREATE (co)-[:YIELDED]->(:Fact {type: $type, value: $value, seq: $seq, ts: $ts})`,
        { cid: consultId, type: f.type, value: String(f.value), seq: f.seq, ts: f.ts });
    },
    async getFacts(consultId) {
      const rows = await q(
        `MATCH (:Consult {id: $cid})-[:YIELDED]->(f:Fact)
         RETURN f.type AS type, f.value AS value, f.seq AS seq ORDER BY f.seq`,
        { cid: consultId });
      const out = {};
      for (const r of rows) out[r.type] = { value: coerce(r.value), seq: r.seq }; // latest seq wins
      return out;
    },

    async learnFromOutcome(evt) {
      const existing = await requirementsMap(evt.payer_id);
      const changed = applyOutcome(existing, evt);

      // 1. Upsert changed Requirement nodes with the freshly computed evidence/confidence.
      for (const r of changed) {
        await q(
          `MATCH (payer:Payer {id: $pid})
           MERGE (payer)-[:REQUIRES]->(r:Requirement {code: $code, payer_id: $pid})
           SET r.params_json = $params_json, r.evidence_count = $n, r.confidence = $conf,
               r.denied_at_max = $dmax, r.approved_at_min = $amin, r.last_seen = $ts
           WITH r MATCH (proc:Procedure {cpt: $cpt}) MERGE (r)-[:FOR_PROCEDURE]->(proc)`,
          {
            pid: evt.payer_id, code: r.code, params_json: JSON.stringify(r.params),
            n: r.evidence_count, conf: r.confidence,
            dmax: r.denied_at_max, amin: r.approved_at_min, ts: r.last_seen,
            cpt: PROCEDURES[evt.cpt] ? evt.cpt : PROCEDURE.cpt, // link the study that taught it
          });
      }

      // 2. Record the event source + Outcome node, linked BECAUSE→ each changed requirement.
      const srcCypher = evt.kind === 'submission'
        ? `MATCH (src:Submission {id: $sid})`
        : `CREATE (src:NetworkEvent {id: $sid, clinic_id: $clinic, ts: $ts, therapy_weeks: $weeks, payer_id: $pid})`;
      await q(
        `${srcCypher}
         CREATE (src)-[:RESULTED_IN]->(o:Outcome {type: $outcome, ts: $ts, src_id: $sid})
         WITH o MATCH (payer:Payer {id: $pid}) MERGE (o)-[:FROM]->(payer)`,
        {
          sid: evt.source_id, clinic: evt.clinic_id || null, ts: evt.ts,
          weeks: evt.packet?.therapy_weeks ?? null, outcome: evt.outcome, pid: evt.payer_id,
        });
      for (const r of changed) {
        await q(
          `MATCH (o:Outcome {src_id: $sid}), (:Payer {id: $pid})-[:REQUIRES]->(r:Requirement {code: $code})
           MERGE (o)-[:BECAUSE]->(r)`,
          { sid: evt.source_id, pid: evt.payer_id, code: r.code });
      }
      if (evt.kind === 'submission') {
        await q(
          `MATCH (s:Submission {id: $sid}) SET s.outcome = $outcome, s.outcome_ts = $ts`,
          { sid: evt.source_id, outcome: evt.outcome, ts: evt.ts });
      }
      return changed.map((r) => r.code);
    },

    async getRequirements(payerId) {
      return [...(await requirementsMap(payerId)).values()];
    },

    /** Read-only console queries from the admin UI. Caller enforces the
        read-only guard; this just shapes rows for a table. */
    async rawQuery(cypher) {
      const rows = (await q(cypher)).slice(0, 100);
      const columns = rows.length ? Object.keys(rows[0]) : [];
      const cell = (v) => (v === null || v === undefined) ? null : (typeof v === 'object' ? JSON.stringify(v) : v);
      return { columns, rows: rows.map((r) => columns.map((c) => cell(r[c]))) };
    },

    async getRequirementEvidence(payerId, code, limit = 5) {
      const rows = await q(
        `MATCH (:Payer {id: $pid})-[:REQUIRES]->(r:Requirement {code: $code})<-[:BECAUSE]-(o:Outcome)<-[:RESULTED_IN]-(src)
         RETURN labels(src)[0] AS src_label, src.id AS src_id, src.clinic_id AS clinic_id,
                o.type AS outcome, o.ts AS ts, src.therapy_weeks AS therapy_weeks
         ORDER BY o.ts DESC LIMIT ${Number(limit)}`,
        { pid: payerId, code });
      return rows.map((r) => ({
        src_kind: r.src_label === 'Submission' ? 'submission' : 'network',
        src_id: r.src_id, clinic_id: r.clinic_id ?? null, outcome: r.outcome, ts: r.ts,
        therapy_weeks: r.therapy_weeks ?? null,
      }));
    },

    async createSubmission(s) {
      await q(
        `MATCH (payer:Payer {id: $pid})
         CREATE (sub:Submission {id: $sid, consult_id: $cid, patient_id: $patient, status: $status,
                 ts: $ts, therapy_weeks: $weeks, pt_notes: $pt_notes, redflag_screen: $screen,
                 order_form: $form, dx: $dx})
         CREATE (sub)-[:TO]->(payer)
         WITH sub MATCH (proc:Procedure {cpt: $cpt}) MERGE (sub)-[:FOR]->(proc)`,
        {
          sid: s.submission_id, cid: s.consult_id || null, patient: s.patient_id || null,
          status: s.status || 'CREATED', ts: s.ts, pid: s.payer_id,
          weeks: s.packet.therapy_weeks ?? null, pt_notes: !!s.packet.pt_notes,
          screen: !!s.packet.redflag_screen, form: !!s.packet.order_form, dx: s.packet.dx || null,
          cpt: PROCEDURES[s.cpt] ? s.cpt : PROCEDURE.cpt,
        });
    },
    async setSubmissionState(id, st) {
      await q(`MATCH (s:Submission {id: $id}) SET s.state = $st`, { id, st });
    },
    async setSubmissionCost(id, c) {
      await q(
        `MATCH (s:Submission {id: $id}) SET s.tokens_in = $ti, s.tokens_out = $to, s.llm_usd = $usd`,
        { id, ti: c.tokens_in, to: c.tokens_out, usd: c.usd });
    },
    async getSubmission(id) {
      const rows = await q(
        `MATCH (s:Submission {id: $id})-[:TO]->(payer:Payer)
         RETURN s.id AS submission_id, s.consult_id AS consult_id, s.patient_id AS patient_id,
                payer.id AS payer_id, s.status AS status, s.state AS state, s.outcome AS outcome`,
        { id });
      return rows[0] || null;
    },

    /** The multi-hop showcase (spec §5): patient → payer → requirements ← because ← outcomes ← network/own submissions. */
    async multiHopEvidence(patientId) {
      const rows = await q(
        `MATCH (pt:Patient {id: $pid})-[:INSURED_BY]->(payer:Payer)
         OPTIONAL MATCH (payer)-[:REQUIRES]->(r:Requirement)
         OPTIONAL MATCH (r)<-[:BECAUSE]-(o:Outcome)<-[:RESULTED_IN]-(src)
         RETURN payer.id AS payer_id, r.code AS code, r.params_json AS params_json,
                r.evidence_count AS evidence_count, r.confidence AS confidence,
                r.denied_at_max AS denied_at_max, r.approved_at_min AS approved_at_min,
                labels(src)[0] AS src_label, src.id AS src_id, src.clinic_id AS clinic_id,
                o.type AS outcome, o.ts AS ts, src.therapy_weeks AS therapy_weeks
         ORDER BY o.ts DESC`,
        { pid: patientId });
      if (!rows.length) return { payer_id: null, requirements: [] };
      const byCode = new Map();
      for (const row of rows) {
        if (!row.code) continue;
        if (!byCode.has(row.code)) byCode.set(row.code, { ...rowToReq(row), evidence: [] });
        const req = byCode.get(row.code);
        if (row.src_id && req.evidence.length < 5) {
          req.evidence.push({
            src_kind: row.src_label === 'Submission' ? 'submission' : 'network',
            src_id: row.src_id, clinic_id: row.clinic_id ?? null,
            outcome: row.outcome, ts: row.ts, therapy_weeks: row.therapy_weeks ?? null,
          });
        }
      }
      return { payer_id: rows[0].payer_id, requirements: [...byCode.values()] };
    },

    async rulebook() {
      const out = [];
      for (const p of Object.values(PAYERS)) {
        out.push({ payer_id: p.id, name: p.name, requirements: await this.getRequirements(p.id) });
      }
      return out;
    },

    async counts() {
      const [row] = await q(`MATCH (n) OPTIONAL MATCH (n)-[e]->() RETURN count(DISTINCT n) AS nodes, count(e) AS edges`);
      const [fr] = await q(`MATCH (f:Fact) RETURN count(f) AS facts`);
      const [rq] = await q(`MATCH (r:Requirement) RETURN count(r) AS reqs`);
      const [ne] = await q(`MATCH (ne:NetworkEvent) RETURN count(ne) AS n`);
      return { nodes: row?.nodes ?? 0, edges: row?.edges ?? 0, facts: fr?.facts ?? 0, requirements: rq?.reqs ?? 0, network_events: ne?.n ?? 0 };
    },
  };
}

function coerce(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v !== '' && v !== null && !Number.isNaN(Number(v))) return Number(v);
  return v;
}
