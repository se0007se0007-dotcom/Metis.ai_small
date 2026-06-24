/**
 * Pure-logic unit test for the agent operational-risk + anomalies backend.
 *
 * Mirrors (and locks in) the pure helpers used by:
 *   - apps/api/src/modules/fds/risk.service.ts  (computeAgentRiskScore, worseSecurity)
 *   - apps/api/src/modules/evaluator/evaluator.service.ts (buildAnomaliesPayload)
 *
 * No server / DB required. Run: node scripts/test-risk-anomaly.mjs
 * ASCII only.
 */

// ----- mirror of risk.service.ts helpers -----
const SECURITY_ORDER = { low: 0, medium: 1, high: 2, critical: 3 };
function worseSecurity(a, b) {
  return (SECURITY_ORDER[a] ?? 0) >= (SECURITY_ORDER[b] ?? 0) ? a : b;
}
function computeAgentRiskScore(acc) {
  const n = acc.evaluations > 0 ? acc.evaluations : 1;
  const avgQualityGap = acc.sumQualityGap / n;
  const avgSecurityGap = acc.sumSecurityGap / n;
  const anomalyRate = (acc.anomalyCount / n) * 100;
  const alertPressure = (Math.min(acc.openAlerts, 5) / 5) * 100;
  const score =
    avgQualityGap * 0.35 + avgSecurityGap * 0.3 + anomalyRate * 0.2 + alertPressure * 0.15;
  return Math.round(Math.max(0, Math.min(100, score)));
}

// ----- mirror of evaluator.service.ts buildAnomaliesPayload -----
function normSev(sev) {
  const s = (sev || '').toLowerCase();
  if (s === 'critical') return 'critical';
  if (s === 'warning') return 'warning';
  return 'info';
}
function dayBucket(d) {
  const dt = typeof d === 'string' ? new Date(d) : d;
  return dt.toISOString().slice(0, 10);
}
function buildAnomaliesPayload(rows, opts = { days: 30, since: '' }) {
  const items = [];
  for (const row of rows || []) {
    const events = Array.isArray(row.anomalyEvents) ? row.anomalyEvents : [];
    for (const ev of events) {
      if (!ev || typeof ev !== 'object') continue;
      const sevNorm = normSev(ev.severity);
      const evType = String(ev.type || 'accuracy_drift');
      if (opts.severity && sevNorm !== normSev(opts.severity)) continue;
      if (opts.type && evType !== opts.type) continue;
      items.push({
        id: row.id,
        workflowKey: row.workflowKey ?? null,
        agentName: row.agentName ?? null,
        stepKey: row.stepKey ?? null,
        type: evType,
        severity: ev.severity ?? 'warning',
        detail: ev.detail ?? '',
        value: typeof ev.value === 'number' ? ev.value : null,
        threshold: typeof ev.threshold === 'number' ? ev.threshold : null,
        algorithm: ev.algorithm ?? null,
        detectedAt: ev.detectedAt ?? dayBucket(row.createdAt),
      });
    }
  }
  const bySeverity = { critical: 0, warning: 0, info: 0 };
  const byType = {
    latency_trend: 0,
    accuracy_drift: 0,
    token_spike: 0,
    error_surge: 0,
    security_pattern: 0,
  };
  const agentCounts = {};
  for (const it of items) {
    bySeverity[normSev(it.severity)]++;
    if (byType[it.type] !== undefined) byType[it.type]++;
    const a = it.agentName || it.workflowKey || 'unknown';
    agentCounts[a] = (agentCounts[a] || 0) + 1;
  }
  const byAgent = Object.entries(agentCounts)
    .map(([agentName, count]) => ({ agentName, count }))
    .sort((x, y) => y.count - x.count);
  const heatMap = new Map();
  for (const it of items) {
    const date = dayBucket(it.detectedAt || opts.since);
    const key = `${date}::${it.type}`;
    let h = heatMap.get(key);
    if (!h) {
      h = { date, type: it.type, count: 0 };
      heatMap.set(key, h);
    }
    h.count++;
  }
  const heatmap = Array.from(heatMap.values()).sort((x, y) =>
    x.date === y.date ? (x.type < y.type ? -1 : 1) : x.date < y.date ? -1 : 1,
  );
  return {
    items,
    summary: { total: items.length, bySeverity, byType, byAgent },
    heatmap,
    window: { days: opts.days, since: opts.since },
  };
}

// ----- tiny test harness -----
let pass = 0;
let fail = 0;
function ok(name, cond) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}`);
  }
}
function eq(name, got, want) {
  ok(`${name} (got=${got}, want=${want})`, got === want);
}

console.log('== worseSecurity ==');
eq('low vs critical', worseSecurity('low', 'critical'), 'critical');
eq('high vs medium', worseSecurity('high', 'medium'), 'high');
eq('low vs low', worseSecurity('low', 'low'), 'low');

console.log('== computeAgentRiskScore ==');
// Perfect agent: 0 gaps, no anomalies, no alerts -> 0
eq(
  'perfect = 0',
  computeAgentRiskScore({
    evaluations: 10,
    sumQualityGap: 0,
    sumSecurityGap: 0,
    anomalyCount: 0,
    openAlerts: 0,
  }),
  0,
);
// Worst agent: max gaps, all anomalies, >=5 open alerts -> 100
eq(
  'worst = 100',
  computeAgentRiskScore({
    evaluations: 10,
    sumQualityGap: 1000,
    sumSecurityGap: 1000,
    anomalyCount: 10,
    openAlerts: 8,
  }),
  100,
);
// Mixed: avgQualityGap=40 (*.35=14), avgSecGap=20 (*.3=6), anomalyRate=50 (*.2=10),
// alertPressure: 2/5*100=40 (*.15=6) -> 36
eq(
  'mixed = 36',
  computeAgentRiskScore({
    evaluations: 10,
    sumQualityGap: 400,
    sumSecurityGap: 200,
    anomalyCount: 5,
    openAlerts: 2,
  }),
  36,
);
ok(
  'higher gaps => higher risk',
  computeAgentRiskScore({
    evaluations: 5,
    sumQualityGap: 250,
    sumSecurityGap: 0,
    anomalyCount: 0,
    openAlerts: 0,
  }) >
    computeAgentRiskScore({
      evaluations: 5,
      sumQualityGap: 50,
      sumSecurityGap: 0,
      anomalyCount: 0,
      openAlerts: 0,
    }),
);

console.log('== buildAnomaliesPayload: flatten + summary + heatmap ==');
const rows = [
  {
    id: 'e1',
    workflowKey: 'wf-a',
    agentName: 'Agent A',
    stepKey: 's1',
    createdAt: '2026-05-01T10:00:00.000Z',
    anomalyEvents: [
      {
        type: 'latency_trend',
        severity: 'critical',
        value: 0.1,
        threshold: 0.05,
        algorithm: 'linear_regression',
        detectedAt: '2026-05-01T10:00:00.000Z',
      },
      {
        type: 'token_spike',
        severity: 'warning',
        value: 5000,
        threshold: 2,
        algorithm: 'iqr',
        detectedAt: '2026-05-01T10:00:00.000Z',
      },
    ],
  },
  {
    id: 'e2',
    workflowKey: 'wf-b',
    agentName: 'Agent B',
    stepKey: 's2',
    createdAt: '2026-05-02T09:00:00.000Z',
    anomalyEvents: [
      {
        type: 'latency_trend',
        severity: 'warning',
        value: 0.07,
        threshold: 0.05,
        algorithm: 'linear_regression',
        detectedAt: '2026-05-02T09:00:00.000Z',
      },
    ],
  },
  {
    id: 'e3',
    workflowKey: 'wf-a',
    agentName: 'Agent A',
    stepKey: 's1',
    createdAt: '2026-05-02T11:00:00.000Z',
    anomalyEvents: [],
  },
];
const out = buildAnomaliesPayload(rows, { days: 30, since: '2026-04-30T00:00:00.000Z' });
eq('total flattened items = 3', out.summary.total, 3);
eq('bySeverity.critical = 1', out.summary.bySeverity.critical, 1);
eq('bySeverity.warning = 2', out.summary.bySeverity.warning, 2);
eq('byType.latency_trend = 2', out.summary.byType.latency_trend, 2);
eq('byType.token_spike = 1', out.summary.byType.token_spike, 1);
eq('byAgent top is Agent A with 2', out.summary.byAgent[0].agentName, 'Agent A');
eq('byAgent top count = 2', out.summary.byAgent[0].count, 2);
// heatmap: (2026-05-01,latency_trend)=1, (2026-05-01,token_spike)=1, (2026-05-02,latency_trend)=1
eq('heatmap buckets = 3', out.heatmap.length, 3);
const hb = out.heatmap.find((h) => h.date === '2026-05-01' && h.type === 'latency_trend');
eq('heatmap 05-01 latency_trend count = 1', hb ? hb.count : -1, 1);

console.log('== buildAnomaliesPayload: filters ==');
const fSev = buildAnomaliesPayload(rows, { days: 30, since: '', severity: 'critical' });
eq('severity=critical -> 1 item', fSev.summary.total, 1);
const fType = buildAnomaliesPayload(rows, { days: 30, since: '', type: 'latency_trend' });
eq('type=latency_trend -> 2 items', fType.summary.total, 2);

console.log('');
console.log(`RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
