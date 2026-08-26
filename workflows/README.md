# Test Automation — SPC Quality Gate (Simulation)

A credential-free n8n workflow that simulates a real industrial QC process end to end.
Built for test automation: every branch is reachable on demand, and runs are reproducible.

- **n8n workflow:** `rXvRmlfK5UKCyerp`
- **Source of truth:** `line3-spc-quality-gate.ts` (n8n Workflow SDK)
- **Persistence:** `qc_historian` n8n Data Table (`Z3r9mX5tNXnNYmwD`)
- **Status:** inactive — activate in the n8n UI to enable the 15-minute schedule
- **Canvas:** 14 functional nodes + 15 documentation stickies (an intro panel and one
  card beneath every node stating what it takes in, what it does, its purpose, and
  what it hands on)

## Why it needs no credentials

| Real plant component | Stood in by |
|---|---|
| PLC / SCADA batch read | `Code` node with a seeded generator |
| Process historian / MES database | n8n Data Table (built in, no credentials) |
| MES line-stop endpoint | `HTTP Request` to a public echo service, on a side branch |
| Shift handover report | `Code` node rendering plain text |

The only outbound call is the echo request, and it runs with
`onError: continueRegularOutput` on a side branch, so a blocked network cannot
fail the run or block the historian write.

## The simulated process

A 500 ml cold-fill bottling line. Each cycle reads 24 bottles, each carrying fill
volume, cap torque and product temperature.

Spec window is 495–505 ml against a 500 ml target. The **established baseline sigma
is 1.20 ml**, taken from process qualification — Western Electric rules are scored
against that baseline, not against the batch's own spread. This matters: scoring
against the sample's own sigma only ever measures *shape*, and can never detect a
mean that has shifted.

### Gate logic

| Verdict | Condition | Action |
|---|---|---|
| `CRITICAL` | any bottle out of spec, or Cpk < 1.00 | line stop + quarantine, dispatch to MES |
| `WARNING` | Cpk < 1.33, any WE rule fires, or torque/temp out of range | maintenance ticket |
| `OK` | none of the above | batch released to palletiser |

Rules applied: Cp and Cpk capability indices, Western Electric rules 1–4
(3-sigma point; 2-of-3 beyond 2-sigma; 4-of-5 beyond 1-sigma; 8-run on one side of
centerline), plus secondary gates on cap torque (1.4–2.2 Nm) and fill temperature
(2–8 °C).

## Driving the test

Everything is controlled from the **Simulation Config** node:

| Field | Purpose |
|---|---|
| `profile` | `auto` rotates the three profiles every minute, or pin one to force a branch |
| `seed` | fixed seed ⇒ byte-identical readings, so this doubles as a regression fixture |
| `sampleSize` | bottles per batch |
| `line` | line identifier written to the historian |

At the default seed each profile maps to exactly one verdict. Verified deterministic
across 12 seeds:

| Profile | Verdict | Default-seed result |
|---|---|---|
| `nominal` | `OK` | Cpk 1.986, no violations |
| `drift` | `WARNING` | Cpk 1.666, WE4 fires at sample 2 |
| `excursion` | `CRITICAL` | Cpk 0.060, 11 bottles out of spec, all four WE rules |

`drift` is the instructive case: capability still looks acceptable, but the control
chart catches the sustained run before it turns into scrap. That is the whole point
of running SPC rules alongside a capability index.

## Reading the canvas

The canvas documents itself. A **README panel** sits above the flow with the scenario,
what is stubbed versus real, and how to drive it. Beneath each node is a numbered card:

| Card | Node | Hands on |
|---|---|---|
| 1 / 1b | Run Test Cycle · Every 15 Min Line Poll | one empty item |
| 2 | Simulation Config | `line` `profile` `sampleSize` `seed` — **the node you edit** |
| 3 | Simulate PLC Batch Read | 24 bottle readings (the only fake part) |
| 4 | Evaluate SPC Rules | 1 verdict item — Cp/Cpk + WE rules |
| 5 | Route by Verdict | the item, down exactly one of three branches |
| 6 | Build Line-Stop Command | the `LINE_STOP` payload |
| 7 | Dispatch Line Stop to MES | echoed payload (side branch, nothing depends on it) |
| 8 / 9 / 10 | Normalize Critical · Warning · Released | one identical 15-column row |
| 11 | Collect QC Event | the surviving row |
| 12 | Write to QC Historian | the stored row + `id` |
| 13 | Build Shift Report | `report` text + summary fields |

## Shape of the flow

```
Manual Trigger  ─┐
                 ├→ Simulation Config → Simulate PLC Batch Read → Evaluate SPC Rules → Route by Verdict
Schedule (15m)  ─┘                                                                          │
                                    ┌───────────────────────────────────────────────────────┤
              CRITICAL → Build Line-Stop Command ─┬→ Dispatch to MES (side branch)          │
                                                  └→ Normalize Critical ──┐                 │
              WARNING  → Normalize Warning ────────────────────────────────┼→ Collect QC Event
              OK       → Normalize Released ───────────────────────────────┘        │
                                                                                    ↓
                                            Write to QC Historian → Build Shift Report
```

All three branches normalise to one identical row shape before converging, so the
historian write is a single node rather than three.

## Taking it to production

1. Replace **Simulate PLC Batch Read** with a real source (OPC-UA, Modbus, MQTT, or an
   HTTP poll against your historian). Nothing downstream changes as long as it emits
   one item per reading with the same field names.
2. Point **Dispatch Line Stop to MES** at your real endpoint and attach credentials, or
   swap it for Slack / PagerDuty / Telegram.
3. Move the historian from the n8n Data Table to Postgres or your plant historian if
   you need retention beyond prototyping.
4. Set the real spec limits and baseline sigma from your own process qualification.
