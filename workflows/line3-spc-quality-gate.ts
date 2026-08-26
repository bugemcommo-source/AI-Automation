import { workflow, node, trigger, sticky, switchCase, merge, expr } from '@n8n/workflow-sdk';

const manualTrigger = trigger({
  type: 'n8n-nodes-base.manualTrigger',
  version: 1,
  config: { name: 'Run Test Cycle', position: [-220, 180] },
  output: [{}]
});

const scheduleTrigger = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.4,
  config: {
    name: 'Every 15 Min Line Poll',
    position: [-220, 400],
    parameters: {
      rule: { interval: [{ field: 'minutes', minutesInterval: 15 }] }
    }
  },
  output: [{}]
});

const simConfig = node({
  type: 'n8n-nodes-base.set',
  version: 3.5,
  config: {
    name: 'Simulation Config',
    position: [20, 290],
    parameters: {
      mode: 'manual',
      includeOtherFields: false,
      assignments: {
        assignments: [
          { id: 'cfg-line', name: 'line', value: 'LINE-03-FILLER', type: 'string' },
          { id: 'cfg-profile', name: 'profile', value: 'auto', type: 'string' },
          { id: 'cfg-sample', name: 'sampleSize', value: 24, type: 'number' },
          { id: 'cfg-seed', name: 'seed', value: 4242, type: 'number' }
        ]
      }
    }
  },
  output: [{ line: 'LINE-03-FILLER', profile: 'auto', sampleSize: 24, seed: 4242 }]
});

const simulateBatch = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Simulate PLC Batch Read',
    position: [240, 290],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const cfg = $input.first().json;
const line = cfg.line || 'LINE-03-FILLER';
const sampleSize = Number(cfg.sampleSize) || 24;
const seed = Number(cfg.seed) || 4242;

const TARGET_ML = 500.0;
const LSL_ML = 495.0;
const USL_ML = 505.0;
const SIGMA_0 = 1.20;

const profiles = {
  nominal:   { meanShift: 0.0, sigma: 0.80, torqueBias: 0.0,   tempBias: 0.0, hardFaults: 0 },
  drift:     { meanShift: 2.0, sigma: 0.85, torqueBias: -0.12, tempBias: 0.9, hardFaults: 0 },
  excursion: { meanShift: 4.9, sigma: 2.55, torqueBias: -0.34, tempBias: 2.7, hardFaults: 3 }
};

const order = ['nominal', 'drift', 'excursion'];
const requested = String(cfg.profile || 'auto').toLowerCase();
const profileName = requested === 'auto'
  ? order[Math.floor(Date.now() / 60000) % 3]
  : (profiles[requested] ? requested : 'nominal');
const p = profiles[profileName];

let state = (seed + profileName.length * 7919) % 2147483647;
function rand() {
  state = (state * 48271) % 2147483647;
  return state / 2147483647;
}
function gauss() {
  const u1 = Math.max(rand(), 1e-9);
  const u2 = rand();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
function round(v, d) {
  const f = Math.pow(10, d);
  return Math.round(v * f) / f;
}
function pad2(v) {
  return String(v).length < 2 ? '0' + String(v) : String(v);
}

const startedAt = new Date();
const batchId = 'B' + startedAt.toISOString().slice(0, 10).replace(/-/g, '') + '-' + pad2(startedAt.getUTCHours()) + pad2(startedAt.getUTCMinutes());
const hour = startedAt.getUTCHours();
const shift = hour < 6 ? 'C-NIGHT' : (hour < 14 ? 'A-MORNING' : (hour < 22 ? 'B-AFTERNOON' : 'C-NIGHT'));

const readings = [];
for (let i = 0; i < sampleSize; i++) {
  const ramp = p.meanShift * ((i + 1) / sampleSize);
  let fill = TARGET_ML + ramp + gauss() * p.sigma;
  if (i < p.hardFaults) {
    fill = TARGET_ML + 9.5 + rand() * 2.5;
  }
  const torque = 1.80 + p.torqueBias + gauss() * 0.09;
  const temp = 4.0 + p.tempBias + gauss() * 0.35;
  readings.push({
    json: {
      batch_id: batchId,
      line: line,
      shift: shift,
      sim_profile: profileName,
      head: (i % 12) + 1,
      seq: i + 1,
      recorded_at: new Date(startedAt.getTime() + i * 2500).toISOString(),
      fill_ml: round(fill, 2),
      cap_torque_nm: round(torque, 3),
      line_temp_c: round(temp, 2),
      target_ml: TARGET_ML,
      lsl_ml: LSL_ML,
      usl_ml: USL_ML,
      sigma_0: SIGMA_0
    }
  });
}

return readings;`
    }
  },
  output: [
    { batch_id: 'B20260826-0915', line: 'LINE-03-FILLER', shift: 'A-MORNING', sim_profile: 'drift', head: 1, seq: 1, recorded_at: '2026-08-26T09:15:00.000Z', fill_ml: 500.31, cap_torque_nm: 1.742, line_temp_c: 4.83, target_ml: 500, lsl_ml: 495, usl_ml: 505 }
  ]
});

const evaluateSpc = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Evaluate SPC Rules',
    position: [470, 290],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const rows = $input.all().map(function (i) { return i.json; });
const first = rows[0];

const TARGET = first.target_ml;
const LSL = first.lsl_ml;
const USL = first.usl_ml;

const fills = rows.map(function (r) { return r.fill_ml; });
const n = fills.length;
const mean = fills.reduce(function (a, b) { return a + b; }, 0) / n;
const variance = n > 1
  ? fills.reduce(function (a, b) { return a + Math.pow(b - mean, 2); }, 0) / (n - 1)
  : 0;
const sigma = Math.max(Math.sqrt(variance), 1e-6);

const cp = (USL - LSL) / (6 * sigma);
const cpk = Math.min(USL - mean, mean - LSL) / (3 * sigma);

const defects = rows.filter(function (r) { return r.fill_ml < LSL || r.fill_ml > USL; });
const torqueFails = rows.filter(function (r) { return r.cap_torque_nm < 1.40 || r.cap_torque_nm > 2.20; });
const tempFails = rows.filter(function (r) { return r.line_temp_c < 2.0 || r.line_temp_c > 8.0; });

const SIGMA_0 = first.sigma_0 || 1.20;
const z = fills.map(function (v) { return (v - TARGET) / SIGMA_0; });
const violations = [];

if (z.some(function (v) { return Math.abs(v) > 3; })) {
  violations.push('WE1: point beyond 3-sigma');
}
for (let i = 0; i + 3 <= n; i++) {
  const w = z.slice(i, i + 3);
  const hi = w.filter(function (v) { return v > 2; }).length;
  const lo = w.filter(function (v) { return v < -2; }).length;
  if (hi >= 2 || lo >= 2) { violations.push('WE2: 2 of 3 beyond 2-sigma at sample ' + (i + 1)); break; }
}
for (let i = 0; i + 5 <= n; i++) {
  const w = z.slice(i, i + 5);
  const hi = w.filter(function (v) { return v > 1; }).length;
  const lo = w.filter(function (v) { return v < -1; }).length;
  if (hi >= 4 || lo >= 4) { violations.push('WE3: 4 of 5 beyond 1-sigma at sample ' + (i + 1)); break; }
}
for (let i = 0; i + 8 <= n; i++) {
  const w = z.slice(i, i + 8);
  const allHi = w.every(function (v) { return v > 0; });
  const allLo = w.every(function (v) { return v < 0; });
  if (allHi || allLo) { violations.push('WE4: 8 consecutive on one side of centerline at sample ' + (i + 1)); break; }
}

let verdict = 'OK';
let action = 'Batch released to palletiser';
if (defects.length > 0 || cpk < 1.00) {
  verdict = 'CRITICAL';
  action = 'Line stop requested, batch quarantined for manual QC';
} else if (cpk < 1.33 || violations.length > 0 || torqueFails.length > 0 || tempFails.length > 0) {
  verdict = 'WARNING';
  action = 'Maintenance ticket raised, filler valve check at next changeover';
}

function round(v, d) {
  const f = Math.pow(10, d);
  return Math.round(v * f) / f;
}

return [{
  json: {
    batch_id: first.batch_id,
    line: first.line,
    shift: first.shift,
    sim_profile: first.sim_profile,
    recorded_at: first.recorded_at,
    evaluated_at: new Date().toISOString(),
    verdict: verdict,
    action: action,
    sample_size: n,
    target_ml: TARGET,
    lsl_ml: LSL,
    usl_ml: USL,
    mean_fill_ml: round(mean, 3),
    sigma_ml: round(sigma, 4),
    baseline_sigma_ml: SIGMA_0,
    cp: round(cp, 3),
    cpk: round(cpk, 3),
    defect_count: defects.length,
    torque_fail_count: torqueFails.length,
    temp_fail_count: tempFails.length,
    we_violations: violations.length > 0 ? violations.join(' | ') : 'none',
    we_violation_count: violations.length,
    min_fill_ml: round(Math.min.apply(null, fills), 2),
    max_fill_ml: round(Math.max.apply(null, fills), 2),
    defect_samples: defects.map(function (d) { return { seq: d.seq, head: d.head, fill_ml: d.fill_ml }; })
  }
}];`
    }
  },
  output: [
    { batch_id: 'B20260826-0915', line: 'LINE-03-FILLER', shift: 'A-MORNING', sim_profile: 'drift', recorded_at: '2026-08-26T09:15:00.000Z', evaluated_at: '2026-08-26T09:16:00.000Z', verdict: 'WARNING', action: 'Maintenance ticket raised, filler valve check at next changeover', sample_size: 24, target_ml: 500, lsl_ml: 495, usl_ml: 505, mean_fill_ml: 501.28, sigma_ml: 1.4102, cp: 1.182, cpk: 0.879, defect_count: 0, torque_fail_count: 0, temp_fail_count: 0, we_violations: 'WE4: 8 consecutive on one side of centerline at sample 9', we_violation_count: 1, min_fill_ml: 498.4, max_fill_ml: 504.2, defect_samples: [] }
  ]
});

const routeByVerdict = switchCase({
  version: 3.4,
  config: {
    name: 'Route by Verdict',
    position: [700, 290],
    parameters: {
      mode: 'rules',
      rules: {
        values: [
          {
            renameOutput: true,
            outputKey: 'Critical - stop line',
            conditions: {
              options: { caseSensitive: false, leftValue: '', typeValidation: 'loose' },
              conditions: [
                { leftValue: expr('{{ $json.verdict }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'CRITICAL' }
              ],
              combinator: 'and'
            }
          },
          {
            renameOutput: true,
            outputKey: 'Warning - raise ticket',
            conditions: {
              options: { caseSensitive: false, leftValue: '', typeValidation: 'loose' },
              conditions: [
                { leftValue: expr('{{ $json.verdict }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'WARNING' }
              ],
              combinator: 'and'
            }
          },
          {
            renameOutput: true,
            outputKey: 'OK - release batch',
            conditions: {
              options: { caseSensitive: false, leftValue: '', typeValidation: 'loose' },
              conditions: [
                { leftValue: expr('{{ $json.verdict }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'OK' }
              ],
              combinator: 'and'
            }
          }
        ]
      },
      options: { looseTypeValidation: true }
    }
  }
});

const buildLineStop = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Line-Stop Command',
    position: [940, 60],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const b = $input.first().json;

return [{
  json: {
    command: 'LINE_STOP',
    issued_at: new Date().toISOString(),
    severity: 'CRITICAL',
    target: { line: b.line, station: 'FILLER-01', shift: b.shift },
    batch_id: b.batch_id,
    reason_code: b.defect_count > 0 ? 'FILL_OUT_OF_SPEC' : 'CPK_BELOW_1_00',
    reason_text: b.defect_count + ' of ' + b.sample_size + ' bottles outside ' + b.lsl_ml + '-' + b.usl_ml + ' ml, Cpk ' + b.cpk,
    quarantine: { batch_id: b.batch_id, sample_size: b.sample_size, hold: true },
    offending_samples: b.defect_samples,
    operator_ack_required: true,
    source: { workflow: $workflow.name, execution: $execution.id, simulated: true }
  }
}];`
    }
  },
  output: [
    { command: 'LINE_STOP', issued_at: '2026-08-26T09:16:00.000Z', severity: 'CRITICAL', target: { line: 'LINE-03-FILLER', station: 'FILLER-01', shift: 'A-MORNING' }, batch_id: 'B20260826-0915', reason_code: 'FILL_OUT_OF_SPEC', reason_text: '3 of 24 bottles outside 495-505 ml, Cpk 0.412', operator_ack_required: true }
  ]
});

const dispatchToMes = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Dispatch Line Stop to MES',
    position: [1180, -80],
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      url: 'https://postman-echo.com/post',
      authentication: 'none',
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify($json) }}'),
      options: { timeout: 10000 }
    }
  },
  output: [{ json: { command: 'LINE_STOP' }, url: 'https://postman-echo.com/post' }]
});

const normalizeCritical = node({
  type: 'n8n-nodes-base.set',
  version: 3.5,
  config: {
    name: 'Normalize Critical Event',
    position: [1180, 140],
    parameters: {
      mode: 'manual',
      includeOtherFields: false,
      assignments: {
        assignments: [
          { id: 'c-batch', name: 'batch_id', value: expr("{{ $('Evaluate SPC Rules').first().json.batch_id }}"), type: 'string' },
          { id: 'c-line', name: 'line', value: expr("{{ $('Evaluate SPC Rules').first().json.line }}"), type: 'string' },
          { id: 'c-shift', name: 'shift', value: expr("{{ $('Evaluate SPC Rules').first().json.shift }}"), type: 'string' },
          { id: 'c-at', name: 'recorded_at', value: expr("{{ $('Evaluate SPC Rules').first().json.evaluated_at }}"), type: 'string' },
          { id: 'c-verdict', name: 'verdict', value: 'CRITICAL', type: 'string' },
          { id: 'c-profile', name: 'sim_profile', value: expr("{{ $('Evaluate SPC Rules').first().json.sim_profile }}"), type: 'string' },
          { id: 'c-n', name: 'sample_size', value: expr("{{ $('Evaluate SPC Rules').first().json.sample_size }}"), type: 'number' },
          { id: 'c-mean', name: 'mean_fill_ml', value: expr("{{ $('Evaluate SPC Rules').first().json.mean_fill_ml }}"), type: 'number' },
          { id: 'c-sigma', name: 'sigma_ml', value: expr("{{ $('Evaluate SPC Rules').first().json.sigma_ml }}"), type: 'number' },
          { id: 'c-cp', name: 'cp', value: expr("{{ $('Evaluate SPC Rules').first().json.cp }}"), type: 'number' },
          { id: 'c-cpk', name: 'cpk', value: expr("{{ $('Evaluate SPC Rules').first().json.cpk }}"), type: 'number' },
          { id: 'c-def', name: 'defect_count', value: expr("{{ $('Evaluate SPC Rules').first().json.defect_count }}"), type: 'number' },
          { id: 'c-we', name: 'we_violations', value: expr("{{ $('Evaluate SPC Rules').first().json.we_violations }}"), type: 'string' },
          { id: 'c-action', name: 'action', value: expr("{{ $('Evaluate SPC Rules').first().json.action }}"), type: 'string' },
          { id: 'c-stopped', name: 'line_stopped', value: true, type: 'boolean' }
        ]
      }
    }
  },
  output: [{ batch_id: 'B20260826-0915', line: 'LINE-03-FILLER', shift: 'A-MORNING', recorded_at: '2026-08-26T09:16:00.000Z', verdict: 'CRITICAL', sim_profile: 'excursion', sample_size: 24, mean_fill_ml: 503.9, sigma_ml: 2.61, cp: 0.638, cpk: 0.141, defect_count: 3, we_violations: 'WE1: point beyond 3-sigma', action: 'Line stop requested, batch quarantined for manual QC', line_stopped: true }]
});

const normalizeWarning = node({
  type: 'n8n-nodes-base.set',
  version: 3.5,
  config: {
    name: 'Normalize Warning Event',
    position: [940, 330],
    parameters: {
      mode: 'manual',
      includeOtherFields: false,
      assignments: {
        assignments: [
          { id: 'w-batch', name: 'batch_id', value: expr('{{ $json.batch_id }}'), type: 'string' },
          { id: 'w-line', name: 'line', value: expr('{{ $json.line }}'), type: 'string' },
          { id: 'w-shift', name: 'shift', value: expr('{{ $json.shift }}'), type: 'string' },
          { id: 'w-at', name: 'recorded_at', value: expr('{{ $json.evaluated_at }}'), type: 'string' },
          { id: 'w-verdict', name: 'verdict', value: 'WARNING', type: 'string' },
          { id: 'w-profile', name: 'sim_profile', value: expr('{{ $json.sim_profile }}'), type: 'string' },
          { id: 'w-n', name: 'sample_size', value: expr('{{ $json.sample_size }}'), type: 'number' },
          { id: 'w-mean', name: 'mean_fill_ml', value: expr('{{ $json.mean_fill_ml }}'), type: 'number' },
          { id: 'w-sigma', name: 'sigma_ml', value: expr('{{ $json.sigma_ml }}'), type: 'number' },
          { id: 'w-cp', name: 'cp', value: expr('{{ $json.cp }}'), type: 'number' },
          { id: 'w-cpk', name: 'cpk', value: expr('{{ $json.cpk }}'), type: 'number' },
          { id: 'w-def', name: 'defect_count', value: expr('{{ $json.defect_count }}'), type: 'number' },
          { id: 'w-we', name: 'we_violations', value: expr('{{ $json.we_violations }}'), type: 'string' },
          { id: 'w-action', name: 'action', value: expr('{{ $json.action }}'), type: 'string' },
          { id: 'w-stopped', name: 'line_stopped', value: false, type: 'boolean' }
        ]
      }
    }
  },
  output: [{ batch_id: 'B20260826-0915', line: 'LINE-03-FILLER', shift: 'A-MORNING', recorded_at: '2026-08-26T09:16:00.000Z', verdict: 'WARNING', sim_profile: 'drift', sample_size: 24, mean_fill_ml: 501.28, sigma_ml: 1.4102, cp: 1.182, cpk: 0.879, defect_count: 0, we_violations: 'WE4: 8 consecutive on one side of centerline at sample 9', action: 'Maintenance ticket raised, filler valve check at next changeover', line_stopped: false }]
});

const normalizeReleased = node({
  type: 'n8n-nodes-base.set',
  version: 3.5,
  config: {
    name: 'Normalize Released Batch',
    position: [940, 560],
    parameters: {
      mode: 'manual',
      includeOtherFields: false,
      assignments: {
        assignments: [
          { id: 'o-batch', name: 'batch_id', value: expr('{{ $json.batch_id }}'), type: 'string' },
          { id: 'o-line', name: 'line', value: expr('{{ $json.line }}'), type: 'string' },
          { id: 'o-shift', name: 'shift', value: expr('{{ $json.shift }}'), type: 'string' },
          { id: 'o-at', name: 'recorded_at', value: expr('{{ $json.evaluated_at }}'), type: 'string' },
          { id: 'o-verdict', name: 'verdict', value: 'OK', type: 'string' },
          { id: 'o-profile', name: 'sim_profile', value: expr('{{ $json.sim_profile }}'), type: 'string' },
          { id: 'o-n', name: 'sample_size', value: expr('{{ $json.sample_size }}'), type: 'number' },
          { id: 'o-mean', name: 'mean_fill_ml', value: expr('{{ $json.mean_fill_ml }}'), type: 'number' },
          { id: 'o-sigma', name: 'sigma_ml', value: expr('{{ $json.sigma_ml }}'), type: 'number' },
          { id: 'o-cp', name: 'cp', value: expr('{{ $json.cp }}'), type: 'number' },
          { id: 'o-cpk', name: 'cpk', value: expr('{{ $json.cpk }}'), type: 'number' },
          { id: 'o-def', name: 'defect_count', value: expr('{{ $json.defect_count }}'), type: 'number' },
          { id: 'o-we', name: 'we_violations', value: expr('{{ $json.we_violations }}'), type: 'string' },
          { id: 'o-action', name: 'action', value: expr('{{ $json.action }}'), type: 'string' },
          { id: 'o-stopped', name: 'line_stopped', value: false, type: 'boolean' }
        ]
      }
    }
  },
  output: [{ batch_id: 'B20260826-0915', line: 'LINE-03-FILLER', shift: 'A-MORNING', recorded_at: '2026-08-26T09:16:00.000Z', verdict: 'OK', sim_profile: 'nominal', sample_size: 24, mean_fill_ml: 500.04, sigma_ml: 1.1213, cp: 1.487, cpk: 1.475, defect_count: 0, we_violations: 'none', action: 'Batch released to palletiser', line_stopped: false }]
});

const collectEvents = merge({
  version: 3.2,
  config: {
    name: 'Collect QC Event',
    position: [1420, 330],
    parameters: { mode: 'append', numberInputs: 3 }
  }
});

const writeHistorian = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Write to QC Historian',
    position: [1640, 330],
    parameters: {
      resource: 'row',
      operation: 'insert',
      dataTableId: { __rl: true, mode: 'list', value: 'Z3r9mX5tNXnNYmwD', cachedResultName: 'qc_historian' },
      columns: { mappingMode: 'autoMapInputData', value: null, matchingColumns: [] }
    }
  },
  output: [{ id: 1, createdAt: '2026-08-26T09:16:01.000Z', updatedAt: '2026-08-26T09:16:01.000Z' }]
});

const buildShiftReport = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Shift Report',
    position: [1860, 330],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const spc = $('Evaluate SPC Rules').first().json;
const cfg = $('Simulation Config').first().json;
const written = $input.all().length;

const tag = spc.verdict === 'CRITICAL' ? '[CRITICAL]' : (spc.verdict === 'WARNING' ? '[WARNING]' : '[OK]');

const lines = [
  tag + ' ' + spc.line + '  batch ' + spc.batch_id + '  shift ' + spc.shift,
  'Simulation profile: ' + spc.sim_profile + ' (requested "' + cfg.profile + '", seed ' + cfg.seed + ')',
  'Samples: ' + spc.sample_size + '   Mean fill: ' + spc.mean_fill_ml + ' ml   Sigma: ' + spc.sigma_ml + ' ml',
  'Spec window: ' + spc.lsl_ml + ' - ' + spc.usl_ml + ' ml (target ' + spc.target_ml + ' ml)',
  'Observed range: ' + spc.min_fill_ml + ' - ' + spc.max_fill_ml + ' ml',
  'Cp ' + spc.cp + '   Cpk ' + spc.cpk + '   (release needs Cpk >= 1.33)',
  'Out-of-spec bottles: ' + spc.defect_count + '   Cap-torque fails: ' + spc.torque_fail_count + '   Temp fails: ' + spc.temp_fail_count,
  'Western Electric: ' + spc.we_violations,
  'Action taken: ' + spc.action,
  'Historian rows written: ' + written
];

return [{
  json: {
    verdict: spc.verdict,
    batch_id: spc.batch_id,
    line: spc.line,
    sim_profile: spc.sim_profile,
    cpk: spc.cpk,
    defect_count: spc.defect_count,
    line_stopped: spc.verdict === 'CRITICAL',
    historian_rows_written: written,
    report: lines.join('\\n')
  }
}];`
    }
  },
  output: [{ verdict: 'WARNING', batch_id: 'B20260826-0915', line: 'LINE-03-FILLER', sim_profile: 'drift', cpk: 0.879, defect_count: 0, line_stopped: false, historian_rows_written: 1, report: '[WARNING] LINE-03-FILLER  batch B20260826-0915  shift A-MORNING' }]
});

const noteConfig = sticky(
  '## 1. Simulated plant floor\nThe Code node stands in for a PLC/SCADA batch read on a 500 ml cold-fill bottling line: 24 bottles, each with fill volume, cap torque and product temperature.\n\n**Drive the test from "Simulation Config":**\n- `profile` — `auto` rotates nominal - drift - excursion every minute, or pin it to one of those three to force a branch. At the default seed each profile lands on exactly one verdict: **nominal -> OK**, **drift -> WARNING**, **excursion -> CRITICAL**\n- `seed` — same seed gives byte-identical readings, so this doubles as a regression fixture\n- `sampleSize` — bottles per batch\n\nNo credentials, no network. Swap this node for a real OPC-UA / Modbus / MQTT source later and nothing downstream changes.',
  [simConfig, simulateBatch],
  { color: 4 }
);

const noteSpc = sticky(
  '## 2. The real logic under test\nTextbook statistical process control, exactly as a QA engineer would specify it:\n\n- **Cp / Cpk** capability indices against the 495-505 ml spec window\n- **Western Electric rules 1-4** on the control chart (3-sigma point, 2-of-3 beyond 2-sigma, 4-of-5 beyond 1-sigma, 8-run on one side), scored against the **established baseline sigma of 1.20 ml** from process qualification - not against the batch's own spread, which would only ever measure shape\n- Secondary gates on cap torque (1.4-2.2 Nm) and fill temperature (2-8 C)\n\n**Verdict:** CRITICAL if any bottle is out of spec or Cpk < 1.00 - WARNING if Cpk < 1.33 or any WE rule fires - otherwise OK.',
  [evaluateSpc, routeByVerdict],
  { color: 3 }
);

const noteMes = sticky(
  '## 3. The only outbound call\nPosts the line-stop command to a public echo endpoint that reflects the payload back, so you can inspect the exact JSON a real MES would receive.\n\n`onError: continueRegularOutput` keeps the run green if the network is blocked, and this sits on a side branch so the historian write never depends on it.\n\n**To go live:** change the URL to your MES/SCADA endpoint and add credentials - or replace the node with Slack / PagerDuty / Telegram.',
  [dispatchToMes],
  { color: 5 }
);

const noteHistorian = sticky(
  '## 4. Persistence and reporting\nAll three branches normalise to one identical row shape before converging, so the historian write is a single node instead of three.\n\nRows land in the **qc_historian** n8n Data Table - built-in storage, no credentials - which is your audit trail across executions. The report node renders the shift summary you would paste into a handover.',
  [collectEvents, writeHistorian, buildShiftReport],
  { color: 6 }
);

export default workflow('line3-spc-quality-gate', 'Line 3 Filler - SPC Quality Gate (Simulation)')
  .add(manualTrigger)
  .to(simConfig)
  .to(simulateBatch)
  .to(evaluateSpc)
  .to(routeByVerdict
    .onCase(0, buildLineStop.to(normalizeCritical.to(collectEvents.input(0))))
    .onCase(1, normalizeWarning.to(collectEvents.input(1)))
    .onCase(2, normalizeReleased.to(collectEvents.input(2))))
  .add(scheduleTrigger)
  .to(simConfig)
  .add(buildLineStop)
  .to(dispatchToMes)
  .add(collectEvents)
  .to(writeHistorian)
  .to(buildShiftReport)
  .add(noteConfig)
  .add(noteSpc)
  .add(noteMes)
  .add(noteHistorian);
