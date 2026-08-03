// Dashboard metrics (spec §11) + cost/ROI module (spec §11B). The ROI figures
// are METERED, not estimated: token costs come from the meter, human seconds
// from measured approval-gate waits, baselines from CAQH constants.
import { ROI } from '../config.js';
import { median } from '../util.js';

export function createMetrics({ bus, cases, meter }) {
  const outcomes = []; // {ts, outcome, attempt, ours}
  const rateSeries = []; // {ts, rate, n}

  function attemptOf(evt) {
    const m = /-a(\d+)$/.exec(evt.mirrored_from || '');
    return m ? Number(m[1]) : 1;
  }

  bus.subscribe('network.events', (evt) => {
    outcomes.push({ ts: evt.ts, outcome: evt.outcome, attempt: attemptOf(evt), ours: !!evt.mirrored_from });
    const window = outcomes.filter((o) => o.attempt === 1).slice(-30);
    if (window.length) {
      const approved = window.filter((o) => o.outcome === 'APPROVED' || o.outcome === 'EXPEDITED').length;
      rateSeries.push({ ts: evt.ts, rate: approved / window.length, n: window.length });
      if (rateSeries.length > 400) rateSeries.splice(0, 100);
    }
  });

  function timeToVerdictMs(c) {
    const sub = c.timeline?.find?.((h) => h.state === 'SUBMITTED') || c.history?.find?.((h) => h.state === 'SUBMITTED');
    const ver = c.timeline?.find?.((h) => h.state === 'VERDICT_RECEIVED') || c.history?.find?.((h) => h.state === 'VERDICT_RECEIVED');
    if (!sub || !ver) return null;
    const at = (x) => (typeof x.at === 'number' ? x.at : Date.parse(x.at));
    return at(ver) - at(sub);
  }

  function caseRoi(c) {
    const tokens = meter.totals(c.case_id);
    const humanMs = c.human_ms || 0;
    const humanCost = (humanMs / 3_600_000) * ROI.PA_STAFF_HOURLY.value;
    const submitted = (c.history || []).some((h) => h.state === 'SUBMITTED');
    const baseline = submitted
      ? ROI.MANUAL_COST_PER_PA.value + (c.denial_avoided ? ROI.REWORK_COST_PER_DENIAL.value : 0)
      : 0;
    const actual = tokens.usd + humanCost;
    return {
      case_id: c.case_id,
      submitted,
      denial_avoided: !!c.denial_avoided,
      manual_baseline_usd: baseline,
      token_usd: tokens.usd,
      tokens_estimated: tokens.estimated,
      human_ms: humanMs,
      human_usd: humanCost,
      actual_usd: actual,
      roi_usd: baseline - actual,
      minutes_saved: submitted ? Math.max(0, ROI.MANUAL_MINUTES_PER_PA_SPECIALIST.value - humanMs / 60_000) : 0,
    };
  }

  return {
    snapshot() {
      const all = cases.all();
      const submitted = all.filter((c) => (c.history || []).some((h) => h.state === 'SUBMITTED'));
      const rois = submitted.map(caseRoi);
      const sum = (k) => rois.reduce((a, r) => a + r[k], 0);
      const ttvs = submitted.map((c) => timeToVerdictMs(c)).filter((x) => x !== null);
      return {
        first_pass_rate_series: rateSeries.slice(-120),
        outcomes_seen: outcomes.length,
        median_ttv_ms: median(ttvs),
        per_case: all.map(caseRoi),
        roi: {
          cases: rois.length,
          manual_equivalent_usd: sum('manual_baseline_usd'),
          actual_usd: sum('actual_usd'),
          token_usd: sum('token_usd'),
          human_usd: sum('human_usd'),
          saved_usd: sum('manual_baseline_usd') - sum('actual_usd'),
          staff_minutes_freed: sum('minutes_saved'),
          any_estimated_tokens: rois.some((r) => r.tokens_estimated),
          constants: ROI,
        },
      };
    },
    receipt(caseId) {
      const c = cases.all().find((x) => x.case_id === caseId);
      if (!c) return null;
      return { ...caseRoi(c), lines: meter.receipt(caseId) };
    },
  };
}
