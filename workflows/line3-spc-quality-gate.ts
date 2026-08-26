import { workflow, node, trigger, sticky, switchCase, merge, expr } from '@n8n/workflow-sdk';

const manualTrigger = trigger({
  type: 'n8n-nodes-base.manualTrigger',
  version: 1,
  config: { name: 'Run Test Cycle', position: [0, 0] },
  output: [{}]
});

const scheduleTrigger = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.4,
  config: {
    name: 'Every 15 Min Line Poll',
    position: [0, 440],
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
    position: [360, 0],
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
    position: [720, 0],
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
    position: [1080, 0],
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
    position: [1440, 0],
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
    position: [1800, 440],
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
    position: [2160, 0],
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
    position: [2160, 460],
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
    position: [1800, 1000],
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
    position: [1800, 1480],
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
    position: [2520, 900],
    parameters: { mode: 'append', numberInputs: 3 }
  }
});

const writeHistorian = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Write to QC Historian',
    position: [2880, 900],
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
    position: [3240, 900],
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

const readme = sticky("# Line 3 Filler — SPC Quality Gate\n## A simulated bottling-line quality check. Runs with zero credentials.\n\n**The story this acts out:** a factory line fills 500 ml bottles. Every 15 minutes, quality control pulls **24 bottles** off the line and measures each one — how full it is, how tight the cap is, how cold the product is. Statistics then decide whether the batch ships, needs a maintenance ticket, or is bad enough to stop the line.\n\n**Why it exists:** every external system is stubbed, so this runs on a brand-new n8n instance with nothing connected. Only the *sensor* is fake — the quality maths, the routing, the storage and the audit trail are all real.\n\n| Real factory part | Stood in by |\n| --- | --- |\n| PLC / SCADA sensor read | `Simulate PLC Batch Read` — a seeded generator |\n| Plant historian database | `qc_historian` — an n8n Data Table |\n| MES line-stop endpoint | `Dispatch Line Stop to MES` — a public echo service |\n\n### Three possible outcomes\n**OK** → release the batch  ·  **WARNING** → raise a maintenance ticket  ·  **CRITICAL** → stop the line and quarantine\n\n### How to drive it\nOpen **Simulation Config** and set `profile` to `nominal`, `drift` or `excursion` to force any outcome you want. The same `seed` produces identical bottles every run, so this doubles as a regression test.\n\n### How to read this canvas\nLeft to right. **Every node has a numbered card beneath it** explaining what it takes in, what it does, why it is there, and what it hands on.", [], {
  name: "README",
  position: [0, -660],
  width: 1560,
  height: 580,
  color: 7
});

const card01 = sticky("### 1 · Run Test Cycle\n`Manual Trigger`\n\n**Does:** starts one QC cycle the moment you hit Execute.\n\n**Takes in:** nothing.\n\n**Purpose:** lets you run any scenario on demand instead of waiting for the clock.\n\n**Hands on:** one empty item `{}`.", [], {
  name: "Card 01 Run Test Cycle",
  position: [0, 140],
  width: 300,
  height: 240,
  color: 7
});

const card01b = sticky("### 1b · Every 15 Min Line Poll\n`Schedule Trigger`\n\n**Does:** fires by itself every 15 minutes.\n\n**Takes in:** nothing — the clock starts it.\n\n**Purpose:** the production cadence, mimicking QC sampling the line each quarter hour.\n\n**Hands on:** one empty item `{}`.\n\n⚠️ Only fires while the workflow is **Active**.", [], {
  name: "Card 01b Schedule",
  position: [0, 580],
  width: 300,
  height: 260,
  color: 7
});

const card02 = sticky("### 2 · Simulation Config\n`Edit Fields (Set)`\n\n**Does:** defines the four knobs that steer the entire run.\n\n**Takes in:** the empty item from either trigger.\n\n**Purpose:** one place to control the test, with no code editing.\n\n**Hands on:** one config item —\n`line` = LINE-03-FILLER\n`profile` = nominal · drift · excursion · auto\n`sampleSize` = 24\n`seed` = 4242\n\n👉 **This is the node you edit.**", [], {
  name: "Card 02 Simulation Config",
  position: [360, 140],
  width: 300,
  height: 300,
  color: 4
});

const card03 = sticky("### 3 · Simulate PLC Batch Read\n`Code` · once for all items\n\n**Does:** invents 24 bottle measurements from a seeded random generator.\n\n**Takes in:** the config item.\n\n**Purpose:** stands in for a real PLC/SCADA read. **The only fake part of this workflow.**\n\n**Hands on:** **24 items**, one per bottle —\n`fill_ml` `cap_torque_nm` `line_temp_c`\n`seq` `head` `batch_id` `shift`\nplus spec limits and `sigma_0`.\n\nSame seed ⇒ identical bottles every run.", [], {
  name: "Card 03 Simulate PLC",
  position: [720, 140],
  width: 300,
  height: 300,
  color: 4
});

const card04 = sticky("### 4 · Evaluate SPC Rules\n`Code` · once for all items\n\n**Does:** the actual quality maths. **This is the logic under test.**\n\n**Takes in:** all 24 bottle readings.\n\n**Purpose:** collapse 24 measurements into one defensible verdict.\n\nComputes **Cp / Cpk** (capability against the 495–505 ml spec) and **Western Electric rules 1–4**, scored against the qualified baseline sigma of 1.20 ml.\n\n**Hands on:** **1 item** — the batch verdict:\n`verdict` `action` `cpk` `cp`\n`mean_fill_ml` `defect_count` `we_violations`", [], {
  name: "Card 04 Evaluate SPC",
  position: [1080, 140],
  width: 300,
  height: 320,
  color: 5
});

const card05 = sticky("### 5 · Route by Verdict\n`Switch`\n\n**Does:** sends the batch down exactly one of three paths.\n\n**Takes in:** the single verdict item.\n\n**Purpose:** one severity, one response. No batch takes two paths.\n\n**Hands on:** the same item, out of one branch only —\n**0** `CRITICAL` → stop the line\n**1** `WARNING` → raise a ticket\n**2** `OK` → release the batch", [], {
  name: "Card 05 Route by Verdict",
  position: [1440, 140],
  width: 300,
  height: 280,
  color: 3
});

const card06 = sticky("### 6 · Build Line-Stop Command\n`Code` · CRITICAL branch only\n\n**Does:** writes the machine-readable stop order.\n\n**Takes in:** the CRITICAL verdict item.\n\n**Purpose:** the exact payload a real MES/SCADA system would accept to halt the filler.\n\n**Hands on:** one command object —\n`command: LINE_STOP`\n`reason_code` `reason_text`\n`quarantine` `offending_samples`\n`operator_ack_required`", [], {
  name: "Card 06 Build Line-Stop",
  position: [1800, 580],
  width: 300,
  height: 280,
  color: 3
});

const card07 = sticky("### 7 · Dispatch Line Stop to MES\n`HTTP Request` · side branch\n\n**Does:** POSTs the stop command to a public echo service that reflects it straight back.\n\n**Takes in:** the line-stop command.\n\n**Purpose:** proves the outbound call works and lets you inspect the exact JSON a real MES would receive.\n\n**Hands on:** the echoed payload. Nothing downstream depends on it.\n\n🔧 **To go live:** point the URL at your MES, or swap for Slack / PagerDuty.", [], {
  name: "Card 07 Dispatch to MES",
  position: [2160, 140],
  width: 300,
  height: 300,
  color: 3
});

const card08 = sticky("### 8 · Normalize Critical Event\n`Edit Fields (Set)`\n\n**Does:** reshapes the batch into the standard 15-column historian row.\n\n**Takes in:** reads back from `Evaluate SPC Rules` — the command object has already replaced `$json` on this branch.\n\n**Purpose:** so all three branches converge on one identical shape.\n\n**Hands on:** 1 row ·\n`verdict: CRITICAL` · `line_stopped: true`", [], {
  name: "Card 08 Normalize Critical",
  position: [2160, 600],
  width: 300,
  height: 280,
  color: 3
});

const card09 = sticky("### 9 · Normalize Warning Event\n`Edit Fields (Set)`\n\n**Does:** the same reshaping, on the warning path.\n\n**Takes in:** the WARNING verdict item.\n\n**Purpose:** identical row shape to the other two branches.\n\n**Hands on:** 1 row ·\n`verdict: WARNING` · `line_stopped: false`", [], {
  name: "Card 09 Normalize Warning",
  position: [1800, 1140],
  width: 300,
  height: 240,
  color: 2
});

const card10 = sticky("### 10 · Normalize Released Batch\n`Edit Fields (Set)`\n\n**Does:** the same reshaping, on the clean path.\n\n**Takes in:** the OK verdict item.\n\n**Purpose:** identical row shape to the other two branches.\n\n**Hands on:** 1 row ·\n`verdict: OK` · `line_stopped: false`", [], {
  name: "Card 10 Normalize Released",
  position: [1800, 1620],
  width: 300,
  height: 240,
  color: 4
});

const card11 = sticky("### 11 · Collect QC Event\n`Merge` · append, 3 inputs\n\n**Does:** funnels the three branches back into a single stream.\n\n**Takes in:** whichever one branch actually ran. The other two are empty.\n\n**Purpose:** lets one storage node serve all three outcomes instead of three duplicates.\n\n**Hands on:** 1 normalized row.", [], {
  name: "Card 11 Collect QC Event",
  position: [2520, 1040],
  width: 300,
  height: 260,
  color: 6
});

const card12 = sticky("### 12 · Write to QC Historian\n`Data table` · insert\n\n**Does:** appends the row to the **qc_historian** table.\n\n**Takes in:** the normalized row, auto-mapped by column name.\n\n**Purpose:** the permanent audit trail — the only thing that outlives the execution.\n\n**Hands on:** the stored row plus `id` and `createdAt`.\n\n✅ No credentials: storage is built into n8n.", [], {
  name: "Card 12 Write to Historian",
  position: [2880, 1040],
  width: 300,
  height: 280,
  color: 6
});

const card13 = sticky("### 13 · Build Shift Report\n`Code` · once for all items\n\n**Does:** renders the human-readable handover summary.\n\n**Takes in:** the stored row, plus a look back at `Evaluate SPC Rules` for the full statistics.\n\n**Purpose:** the part a person actually reads at shift change.\n\n**Hands on:** 1 item —\n`report` (multi-line text) `verdict`\n`cpk` `line_stopped` `historian_rows_written`", [], {
  name: "Card 13 Build Shift Report",
  position: [3240, 1040],
  width: 300,
  height: 280,
  color: 6
});

export default workflow('line3-spc-quality-gate', 'Test Automation - SPC Quality Gate (Simulation)')
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
  .add(readme)
  .add(card01)
  .add(card01b)
  .add(card02)
  .add(card03)
  .add(card04)
  .add(card05)
  .add(card06)
  .add(card07)
  .add(card08)
  .add(card09)
  .add(card10)
  .add(card11)
  .add(card12)
  .add(card13);
