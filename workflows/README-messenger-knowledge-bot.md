# Messenger Knowledge Bot

A Facebook Page that answers customer messages from a knowledge base the business
owner controls — grounded in that knowledge, escalating to a human when it isn't,
and rate-limited so a bad actor cannot run up the model bill.

**Source:** [`messenger-knowledge-bot.ts`](./messenger-knowledge-bot.ts) (n8n Workflow SDK)
**Schema:** [`001`](../db/001_messenger_bot_schema.sql) · [`003`](../db/003_phase4_escalation.sql) · [`005`](../db/005_editor_surface.sql) · [`007`](../db/007_retrieval.sql) · [`009`](../db/009_ops_and_alerts.sql)
**Tests:** [`002`](../db/002_schema_tests.sql) (18) · [`004`](../db/004_phase4_tests.sql) (18) · [`006`](../db/006_editor_tests.sql) (14) · [`008`](../db/008_retrieval_tests.sql) (19) · [`010`](../db/010_ops_tests.sql) (16)
**For the owner:** [Teaching your bot](./GUIDE-teaching-your-bot.md) · [NocoDB deployment](../infra/nocodb/)

All six phases of the build plan. Retrieval is built but **ships switched
off** — see [Retrieval](#retrieval).

## The seven flows

Seven independent triggers, so each runs as its own execution and none can take
the others down.

| Flow | Entry point | What it does |
| --- | --- | --- |
| **A** Verify | `GET /webhook/fb-messenger-bot` | Answers Meta's one-time webhook challenge |
| **B** Conversation | `POST /webhook/fb-messenger-bot` | The bot. One inbound message, end to end |
| **C** CRM sync | hourly schedule | Pushes contacts and transcripts into GoHighLevel |
| **D** SLA sweep | every 10 minutes | Chases unanswered escalations, returns finished threads to the bot |
| **E** Indexing | every 15 minutes | Chunks and embeds only the documents that changed |
| **F** Failure handler | this workflow's own errors | Catches anything that threw, groups it by which dependency failed |
| **G** Watchdog | every 30 minutes | Six health checks, including the silence test an expired token would hide |

Both webhooks share one path because Meta requires the same URL for verification
and for events; only the HTTP method differs.

```
A1 Verify (GET) → A2 Check Token → A3 Respond Challenge

B1 Inbound (POST) ─┬→ B2 Ack Meta 200                    (parallel, immediate)
                   │
                   └→ B3 HMAC → B4 Verify + Normalize → B5 Route the event
                        ├ human_reply → B5a A human took over
                        ├ drop        → B5b Ignore (echo / forgery)
                        └ process     → B6 bot_gate() → B7 Answer, escalate or stop
                             ├ stop     → B8 Stop (already logged)
                             ├ escalate → B19 Handover line → B20 Open escalation
                             │            → B21 Send → B22 Build alert ─┐
                             └ answer   → B9 Typing → B10 Knowledge     │
                                          → B11 Context → B12 Claude    │
                                          → B13 Verdict → B14 Log       │
                                          → B15 Send → B16 Answered?    │
                                              ├ true  → B17 Done        │
                                              └ false → B22b Build alert┤
                                                                        ↓
                                                             B23 Alert the team

C1 Hourly → C2 Find unsynced → C3 Loop ─→ C4 Upsert ─┬→ C5 Note → C6 Save ID
                                                      └→ C7 Record failure

D1 Every 10 min ─┬→ D2 Overdue escalations → D3 Chase → D4 Record the chase
                 └→ D5 Return quiet threads to the bot

E1 Every 15 min → E2 Stale docs → E3 Loop → E4 Chunk → E5 Embed ─┬→ E6 Pair → E7 Store
                                                                 └→ E8 Leave stale

F1 Error trigger → F2 Classify → F3 Record

G1 Every 30 min → G2 Health checks → G3 Pending alerts → G4 Loop → G5 Alert → G6 Throttle
```

Inside Flow B, B10 is where the two knowledge modes diverge and immediately
converge again:

```
B9 Typing → B10 Retrieval settings → B10a Retrieval on?
                        ├ yes → B10b Embed question → B10c Retrieve chunks ─┐
                        └ no  → B10d Whole knowledge base ──────────────────┤
                                                                            ↓
                                                          B11 Assemble context → B12 Claude
```

## Why the Webhook node and not the Facebook Trigger

The Facebook Trigger handles Meta's challenge automatically, which is genuinely
convenient — but it does not expose raw request headers, and without those
`X-Hub-Signature-256` cannot be verified.

That check is not optional. An n8n webhook URL is a public endpoint. Without a
signature check, anyone who discovers it can post fake customer messages, burn
the Anthropic budget, and poison the conversation logs. Flow A exists purely as
the cost of doing this properly.

## Anti-spam, and why it is one SQL function

Every guard lives in `bot_gate()`, called once at **B6**:

| Guard | Trips when |
| --- | --- |
| Duplicate message | Meta replays a webhook with a `mid` already seen |
| Blocked contact | The contact was auto-blocked by an earlier flood |
| Human handling | A person has taken over the thread — the bot goes quiet |
| Empty message | Sticker or reaction with no text |
| Hourly limit | More than 20 messages from one person in a rolling hour |
| Daily limit | More than 60 in a rolling day → auto-block |
| Repeated text | The same message 5 times in 10 minutes → auto-block |
| Global message cap | More than 5,000 across everyone in a UTC day |
| Global spend cap | More than USD 25 of estimated model spend in a UTC day |

Two reasons this is one function rather than a chain of IF nodes:

**Races.** Every check is read-then-decide. Spread across separate nodes, two
messages arriving 50 ms apart both read *"19 messages this hour"*, both conclude
they are under the limit of 20, and both proceed. Inside one statement against
one snapshot, that cannot happen.

**Cost.** One database round trip instead of six, and a rejected message costs
zero model tokens because the workflow stops long before Claude is reached.

Limits live in the `bot_config` table, so tuning them is a row edit rather than
a deploy. Inbound text is truncated to `max_input_chars` (1,000) rather than
rejected, which caps the token cost of any single hostile message.

`bot_gate()` also returns the recent conversation history in the same call, so
the workflow needs no second query to build context.

## Escalation and the human path

### Getting to a human

Three routes in, all landing in the same place — `conversations.status`
becomes `escalated`, the bot goes quiet on that thread, and an alert fires.

| Route | Where it fires | Costs a model call? |
| --- | --- | --- |
| **A rule matched** | `bot_gate()`, before anything else | **No** |
| **Asked the same thing too often** | `bot_gate()` | **No** |
| **The model declined** | `answered: false` from B12 | Yes — it had to read the question |

The first two are deterministic and live in the `escalation_rules` table:
case-insensitive regex, editable in NocoDB beside the knowledge base. When the
owner notices the bot fumbling anything about "gcash refund", they add a row.

"Can I talk to a person" should reach a person whether or not the model agrees
it counts, and should not cost two cents to establish. That is why these run
before the model rather than as prompt instructions. Ships with six rules
covering requests for a human, money disputes, cancellations, existing
bookings, medical or safety questions, and legal or press contact — in English
and Tagalog.

`repeat_question_limit` (2, so the third identical question hands over) sits
deliberately below `repeat_text_limit` (4, so the fifth blocks). A frustrated
customer reaches a human *before* they are ever treated as a flooder.

### Getting back out, without building any UI

Meta stamps replies typed in the **Facebook Page inbox** with app id
`263902037430900`. Phase 3 threw every echo away; Phase 4 treats an echo
carrying that id as what it actually is — proof a human has picked the
conversation up.

So the handoff needs no button, no second app, and no polling. Whoever answers
escalations opens the Page inbox and replies, exactly as they would have
anyway. The system notices, records the reply, stops the SLA clock, and marks
the thread `human`.

Meta also applies the `HUMAN_AGENT` tag to inbox replies automatically, which
extends the reply window from 24 hours to 7 days. Answering where you always
would is also the compliant thing to do.

Threads return to the bot in one of two ways:

- **`bot_release(psid)`** — explicit, and granted to `editor_role` so whoever
  works the queue can call it.
- **Auto-release** — D5, for threads where a human replied and the conversation
  then went quiet for `auto_release_hours` (24). Deliberately narrow: a thread
  **nobody ever answered is never auto-released**, because that would silently
  drop a customer who was promised a callback — the exact failure this phase
  exists to prevent.

### The SLA

An escalation nobody looks at is just a row in a table. Every escalation gets
`sla_due_at = now() + escalation_sla_minutes` (15). D1 runs every 10 minutes:

- `bot_pending_nudges()` returns escalations past their SLA with no human reply
  yet, and not chased within `escalation_nudge_every_minutes` (60).
- D3 chases, D4 records the chase — without which the same escalation re-alerts
  every 10 minutes, which is how alerting gets muted by the people it is meant
  to reach.
- Once a human replies, `first_response_at` is set and it is never chased again.

### Watching it

```sql
select * from v_escalation_queue;   -- who is waiting, how long, SLA breached?
select * from v_handoff_stats;      -- escalations/day by trigger, avg response time
```

`v_handoff_stats` splits by trigger, which is the number that tells you whether
your rules are earning their place: a high `by_rule` count with a low
`by_model` count means the deterministic layer is catching things before they
cost anything.

## Security posture

| Control | Where |
| --- | --- |
| `X-Hub-Signature-256` verified against the App Secret over the **raw** body | B3 + B4 |
| Non-Messenger requests rejected with no execution created | B1 `onlyRunIf` |
| `is_echo` filtered, so the bot cannot answer itself in a loop | B4 |
| Replays deduped on `mid` (UNIQUE index) | B6 |
| Customer text wrapped in `<customer_message>` and declared non-instructional | B12 |
| Bot has **no tools** — it can read knowledge and write a log, nothing else | B12 |
| Sensitive topics (money, medical, legal) never reach the model at all | B6 rules |
| Human-agent echoes matched on Meta's app id, not on message content | B4 |
| Per-contact and global rate limits, global daily spend cap | B6 |
| Bot cannot read draft knowledge — enforced by RLS, not by a `WHERE` clause | schema |
| Editor cannot read customer messages at all — no grant | schema |
| All five secrets in the credential store, never in node parameters | throughout |

The signature comparison in B4 is written to avoid short-circuiting on the first
differing byte.

### Roles

Neither service connects as `postgres` or `service_role`.

| Role | Used by | Can |
| --- | --- | --- |
| `bot_role` | n8n | Call the two guard functions, read **published** knowledge, update conversations |
| `editor_role` | NocoDB | Read and write knowledge in all states, work the escalation queue |

`editor_role` has no grant on `messages` or `kb_audit`. `bot_role` sees only
published rows even if it asks for everything — verified by tests T14–T18.

## Tuning

Everything lives in `bot_config` as rows, so changing a limit is an edit, not a
deploy.

| Key | Default | What it controls |
| --- | --- | --- |
| `rate_limit_per_hour` | 20 | Messages per person per rolling hour |
| `rate_limit_per_day` | 60 | Per rolling day; tripping it auto-blocks |
| `repeat_text_limit` | 4 | Identical messages in 10 min before blocking |
| `repeat_question_limit` | 2 | Identical questions before handing to a human |
| `global_daily_message_cap` | 5000 | Across everyone, per UTC day |
| `global_daily_spend_usd` | 25.00 | Estimated model spend, per UTC day |
| `max_input_chars` | 1000 | Inbound text is truncated, not rejected |
| `escalation_sla_minutes` | 15 | Before an unanswered escalation is chased |
| `escalation_nudge_every_minutes` | 60 | Between repeat chases |
| `auto_release_hours` | 24 | Quiet time before a finished thread returns to the bot |

## Setup

### 1. Database

```bash
psql "$SUPABASE_DB_URL" -f db/001_messenger_bot_schema.sql
psql "$SUPABASE_DB_URL" -f db/003_phase4_escalation.sql
psql "$SUPABASE_DB_URL" -f db/005_editor_surface.sql
psql "$SUPABASE_DB_URL" -f db/007_retrieval.sql   # needs the pgvector extension
psql "$SUPABASE_DB_URL" -f db/009_ops_and_alerts.sql
```

Change `CHANGE_ME_BOT` and `CHANGE_ME_EDITOR` in Section 8 first, or `ALTER ROLE`
straight afterwards. To verify the guards behave, run the tests against a
**scratch database** — they write rows, block contacts and rewrite limits:

```bash
psql "$SCRATCH_DB_URL" -f db/001_messenger_bot_schema.sql
psql "$SCRATCH_DB_URL" -f db/003_phase4_escalation.sql
psql "$SCRATCH_DB_URL" -f db/005_editor_surface.sql
psql "$SCRATCH_DB_URL" -f db/002_schema_tests.sql
psql "$SCRATCH_DB_URL" -f db/004_phase4_tests.sql
psql "$SCRATCH_DB_URL" -f db/007_retrieval.sql
psql "$SCRATCH_DB_URL" -f db/006_editor_tests.sql
psql "$SCRATCH_DB_URL" -f db/009_ops_and_alerts.sql
psql "$SCRATCH_DB_URL" -f db/008_retrieval_tests.sql
psql "$SCRATCH_DB_URL" -f db/010_ops_tests.sql
```

85 tests, all passing on Postgres 16 + pgvector 0.6. All five test files are
re-runnable.

### 2. Credentials

Five, all named on the nodes:

| Credential | Type | Holds |
| --- | --- | --- |
| `Meta App Secret` | Crypto | App Secret, for the HMAC. **Not** the Page token |
| `Meta Page Access Token` | HTTP Templated Custom Auth | `{"headers":{"Authorization":"Bearer {{api_key}}"}}` |
| `Supabase — bot_role` | Postgres | `bot_role` connection string |
| `Anthropic` | Anthropic | Anthropic API key |
| `OpenAI Embeddings` | HTTP Templated Custom Auth | `{"headers":{"Authorization":"Bearer {{api_key}}"}}` — only needed with retrieval on |
| `GoHighLevel Private Integration Token` | HTTP Templated Custom Auth | `{"headers":{"Authorization":"Bearer {{api_key}}"}}` |

Three different Meta secrets are involved and they are easy to confuse:

- **App Secret** — signs webhooks. Goes in the Crypto credential.
- **Page Access Token** — sends messages. Goes in the HTTP credential.
- **Verify Token** — a string *you invent* and paste into Meta. Goes in `FB_VERIFY_TOKEN`.

### 3. Environment variables

```
FB_VERIFY_TOKEN=<any long random string, also pasted into Meta>
GHL_LOCATION_ID=<GoHighLevel sub-account id>
```

### 4. Meta

Point the webhook at the **production** URL (not the test URL — that only works
while the editor is open), subscribed to `messages` and `messaging_postbacks`.
Meta calls `GET` once to verify, then `POST`s events.

Public access needs App Review with Advanced Access on `pages_messaging`, which
needs Business Verification. Budget around 20 days. Page admins and testers can
message the bot immediately without any of that — build against that first.

## The knowledge editor

Phase 5 hands the knowledge base to someone who is not a developer, which
changes the threat model: from here, the most likely way this breaks is not an
attacker, it is a well-meaning owner typing something the database takes
literally.

### The bug that made this urgent

Phase 4 let an editor put an arbitrary regex into `escalation_rules`, and
`bot_gate` matched against it with no protection. A single unbalanced bracket —
`refund(` — made `bot_gate` raise on **every inbound message, for every
customer**, until someone found the row. Reproduced before writing the fix.

Fixed in two layers, because either alone would only be enough on a good day:

- **On write** — a trigger rejects an invalid pattern, an empty pattern, and a
  pattern that matches the empty string (which would hand the entire inbox to a
  human). The error text names the rule and says what to do.
- **On read** — `bot_gate` now matches rules one at a time, each inside its own
  exception block. A rule that raises **deactivates itself** and is skipped, so
  the customer still gets their answer. Read-side tolerance matters even with
  write-side validation, because rules can arrive by routes the trigger never
  sees: a restored backup, a direct `COPY`, a migration from another system.

Validation is skipped when a rule is being switched **off**. That is not a
loophole — it is what makes the self-healing path work. Validating a pattern on
the way to disabling it would block the fix and re-break the bot. E5 asserts
exactly this.

### What the owner sees

NocoDB renders whatever table you point it at, so pointing it at `kb_documents`
would show a uuid primary key, `embedding_stale` and `sort_order` to someone
who wants to fix a price. Three views sit in between:

| View | Purpose | Writable |
| --- | --- | --- |
| `kb_editor` | The knowledge base, friendly column names | Yes |
| `rules_editor` | Escalation rules | Yes |
| `queue_editor` | Questions waiting for a human | Read-only |

The first two are single-table projections, which Postgres makes automatically
updatable — NocoDB reads and writes through them with no extra work, and the
validation triggers still fire (asserted by E12).

`queue_editor` joins `conversations`, which `editor_role` deliberately cannot
read. The view runs with `security_invoker = false`, so the editor sees the
queue without gaining access to the underlying table.

### Closing the loop in one call

```sql
select * from kb_answer_escalation(
  <escalation id>,
  'Home service',
  'Yes, we offer home service within Metro Manila for an extra PHP 500.',
  'services');
```

Publishes the document, resolves **every** open escalation asking that same
question, and hands **all** of those threads back to the bot.

That last word matters. The first version released only the thread whose id was
passed in — so a second customer who asked the same thing had their escalation
closed while their conversation stayed muted, leaving them stranded with a bot
told to stay silent. Caught by E13, which now asserts both contacts come back.

### Deployment

[`infra/nocodb/`](../infra/nocodb/) has a runnable compose file. Two notes:

- NocoDB is bound to `127.0.0.1` only. Putting a database editor on a public
  port is how these end up indexed — reach it over an SSH tunnel or behind a
  reverse proxy with TLS and auth.
- NocoDB keeps its own metadata in a separate Postgres container, **not** in the
  Supabase database, so a NocoDB upgrade can never migrate something the bot
  depends on.

The Supabase connection is added inside NocoDB rather than in `.env`, so a
production database password is not sitting in a file next to a compose config.
Connect as `editor_role` — never `postgres` or `service_role`.

## Safety nets

Everything before Phase 7 handled the failures it expected. This section is
about the ones it did not.

### What can go wrong, and what notices

| Failure | Symptom | What catches it | Customer impact |
| --- | --- | --- | --- |
| **Meta token expired** | Nothing arrives. No error anywhere. | G2 silence check | Total — and invisible without this |
| **Webhook unsubscribed** | Same as above | G2 silence check | Total |
| **Send rejected by Meta** | Reply logged but never received | B15b, raises `critical` | Per-message, silent before |
| **Claude down / 529** | Node throws | F1 → `anthropic/model_unavailable` | Total while it lasts |
| **Database unreachable** | Everything throws | F1 → `database/db_unavailable` | Total |
| **Embedding API fails** | Indexing falls behind | F1 → `warning`; E8 leaves it stale | None — retrieval falls back |
| **GoHighLevel down** | Contacts do not sync | C7; F1 → `warning` | None — retries next hour |
| **Spend cap hit** | Bot refuses new messages | G2 `spend`, warns at 80% first | Total until UTC midnight |
| **Index has two embedding models** | Answers quietly worse | G2 `retrieval` | Degraded, no error |
| **Nobody works the queue** | Customers wait | G2 `escalation_backlog` + D3 chases | Slow, per-customer |
| **Bad escalation rule** | Would have broken every message | Validated on write, self-healing on read | None |

### Answered is not received

The bug this phase fixed: B14 logged the reply and B15 sent it **afterwards**,
so a failed send still counted as `answered = true`.

The answer rate looked healthy while customers got nothing — the worst kind of
failure, because the metric you would check to spot it was the metric that was
lying. Delivery is now confirmed separately:

```sql
select * from v_answer_rate;      -- what the bot decided
select * from v_delivery_health;  -- what the customer actually received
```

When those two diverge, delivery is broken, not the model.

### Watching for an absence

The hardest failure to detect, because it looks exactly like success. An
expired Page Access Token or a dropped webhook subscription produces no error,
no failed request, nothing in any log — messages simply stop arriving, which is
indistinguishable from a quiet Tuesday.

A naive "alert if quiet for six hours" pages you every night. So the check is
comparative: alarm only if this window is silent **and** the same clock window
on the same weekday normally carried traffic, averaged over the previous four
weeks. A business that is genuinely closed on Sundays is never woken up; a Page
whose token expired is. Tests O11–O13.

### Saying it once

Events collapse by fingerprint (`source:code`), so an outage firing every few
minutes for six hours is **one row with a rising count**, not hundreds of rows
and hundreds of alerts. The alert queue then re-announces only after
`alert_repeat_minutes` (60).

⚠️ This is not polish. Alerting that fires every cycle during an outage gets
muted by the people it exists to reach, and then it is worse than nothing.

Severity can escalate but never silently downgrade — a single info-level
recurrence cannot quietly demote a critical (O3). And a resolved problem
recurring opens a **fresh row** rather than reviving the old one, so "how long
has this been broken?" stays honest (O6).

### Checking on it yourself

```sql
select * from bot_health();          -- six verdicts, right now
select * from ops_events
 where resolved_at is null
 order by severity, last_seen_at desc;   -- what is currently broken
select * from v_delivery_health;     -- are replies actually arriving
```

### What is still not covered

- **n8n itself being down.** Nothing inside n8n can alert on that. If the bot
  going dark for hours matters, point an external uptime monitor at the
  webhook URL — that is the one gap this design cannot close from the inside.
- **Alerts go to one URL.** No on-call rota, no escalation if the first person
  does not respond.
- **No automatic retry of a failed send.** The reply is recorded as undelivered
  and alerted, but a human re-sends it.

## Cost

Roughly **USD 0.02 per message** with a 20,000-token knowledge base: the base is
cached for an hour so it bills at about a tenth of the input rate, and only the
question, the history and the reply are charged in full.

Cost is estimated in B13 from character counts rather than metered — the Agent
node does not surface token usage — and written to `messages.cost_usd`, which is
what the global spend cap reads. It is a budget guard, not an invoice; treat
Anthropic's own usage dashboard as the source of truth.

`select * from v_daily_spend;` and `select * from v_answer_rate;` give the
running numbers.

## GoHighLevel

GoHighLevel ships no n8n node, so Flow C calls the LeadConnector v2 REST API
directly. `Version: 2021-07-28` is required on every request and `locationId`
identifies the sub-account.

It is deliberately a **separate hourly flow**, not part of the conversation.
Inline CRM writes would add latency to every customer reply and let a
GoHighLevel outage break the bot. Here the worst case is a contact syncing an
hour late.

Contacts sync once they have sent at least two messages — enough to filter out
accidental one-word openers. On failure, C7 records the error and leaves
`ghl_contact_id` null, so the next sweep retries automatically; a permanent
failure shows up as a populated `ghl_sync_error` rather than as endless silence.

Each contact carries the `messenger-bot` tag, their PSID in a custom field, and
a note holding the last 12 turns of the conversation.

## Working the bot

The loop that makes it better over time, and the one to hand to the client:

```sql
select * from v_content_backlog;   -- unanswered questions, ranked by frequency
```

Answer the top ones as `kb_documents` rows, set `status = 'published'`, done.
The bot improves the next message. Nobody deploys anything.

`answered = false` is the bot working correctly, not failing. Expect an answer
rate of 50–65% at launch and 80%+ after a few rounds of curation.

## Retrieval

Built, tested, and **shipped switched off**. `retrieval_enabled` is `false`, so
nothing about the bot's behaviour changes until someone flips one row.

That is not hedging. Retrieval is the first change in this build that can make
answers *worse* rather than merely broken — a bad chunking or a stale index
degrades quality quietly, with no error anywhere. The only honest response to
that is a switch you can flip back in seconds.

### When to turn it on

While the knowledge base fits in a cached prompt, sending all of it is better:
the model sees everything rather than a guessed top-six, which is why it
handles compound questions ("how much is a deep tissue *and* are you open
Sunday?") that break naive retrieval. Turn retrieval on when one of these is
true:

- The base passes ~100,000 tokens and the Claude line starts to hurt
- Hundreds of products or SKUs with individual detail
- Content changes several times a day, so the cache keeps invalidating
- **You resell this to multiple clients** — the trigger most likely to fire

### What it costs, and what it saves

Per message, with a 20,000-token knowledge base:

| | Whole base cached | Retrieval (6 chunks ≈ 3,000 tokens) |
| --- | --- | --- |
| Knowledge, cached read | $0.0100 | $0.0015 |
| History + question | $0.0050 | $0.0050 |
| Reply | $0.0050 | $0.0050 |
| Question embedding | — | ~$0.0000002 |
| **Per message** | **≈ $0.020** | **≈ $0.012** |

At 2,500 messages/month that is $50 against $30 — not worth the moving parts.
At 10,000 it is $200 against $115, and the two days of build pay for
themselves in a month. `select * from v_daily_spend;` tells you which side of
that line you are on.

### How search actually works

Hybrid: pgvector cosine similarity **fused with Postgres full-text**, combined
by Reciprocal Rank Fusion.

Pure vector search is bad at exact tokens — prices, "HMO", "GCash", a product
code — which is precisely what customers ask about. Keyword search is bad at
paraphrase. Neither alone is enough, and their scores are not on comparable
scales, so fusion is by **rank** rather than by score.

Test R8 makes the case concretely. A customer asks *"do you accept HMO cards"*
with a query vector pointing nowhere near the HMO document:

| Document | Vector rank | Keyword rank | Fused score |
| --- | --- | --- | --- |
| HMO policy | 2 | **1** | **0.0325** |
| Opening hours | 1 | — | 0.0164 |

Pure vector search would have answered with the opening hours. Fusion promotes
the right document to the top.

### The safety net, precisely

Vector search always returns *something* when the index has rows — the nearest
chunks, however far away. So `kb_context()` does **not** fall back on a weak
match; a weak match is handled where it should be, by the model declining from
thin context and the question landing in the escalation queue.

It falls back when the result set is genuinely **empty**: an index never built,
an ingestion that never ran, every chunk still awaiting a vector. Without that,
those cases would hand the model zero context, make it decline every question,
and escalate the entire inbox — a quiet indexing problem surfacing as a visible
outage. Asserted by R17b.

### Indexing

Flow E runs every 15 minutes and only touches documents that changed.
`kb_ingestion_pending()` defines "changed" in SQL rather than in the workflow,
so the two cannot drift: never indexed, edited since last index, or embedded
with a different model than the one configured.

Chunking is **in SQL and deterministic** (R4). A Code node producing slightly
different chunks on a retry would leave the index quietly disagreeing with the
document it came from. Headings are prepended to the embedded text, because a
naked chunk retrieves badly — "PHP 1,800 for 60 minutes" is ambiguous without
"Deep tissue massage pricing" attached.

`kb_store_chunks()` replaces a document's index in one transaction and refuses
two things loudly rather than corrupting quietly: a **zero-chunk payload**
(which would silently remove the document from search) and a **dimension
mismatch** (which would mix vector shapes in one index). R9 and R10.

Delete-then-insert, not upsert: a re-chunk can produce *fewer* chunks than
before, and an upsert would leave the extras behind, still matching searches.
R11.

🔒 **The lock-in.** Embedding models are dimension-locked and not
interchangeable. Changing `embedding_model` means re-embedding everything —
which is why that config row is the mechanism: change it, and every document
becomes pending with `reason = 'model_changed'`, so the re-index is a resumable
background sweep rather than a manual rebuild. R13.

### Watching it

```sql
select * from v_retrieval_health;
```

Retrieval fails quietly — a stale index does not raise, it just answers
slightly worse. Watch `chunks_missing_vectors`, `docs_awaiting_reindex`, and
especially `distinct_models`: anything above 1 means two embedding generations
are in the same index and results are meaningless until the sweep finishes.

### Turning it off

```sql
update bot_config set value = 'false' where key = 'retrieval_enabled';
```

Takes effect on the next message. The chunks stay indexed, so turning it back
on costs nothing.

## Known gaps

- **Cost is estimated, not metered.** See [Cost](#cost).
- **The 24-hour window is not enforced in code.** Flows B and D only ever reply
  to an inbound message or alert the team internally, so nothing this system
  sends to a customer is ever outside the window. Any *outbound-initiated*
  follow-up added later must check `conversations.last_message_at` first.
- **Attachments are acknowledged, not read.** Images and voice notes get a canned
  reply asking for words.
- **Escalation alerts go to one URL.** No routing by topic or on-call rota — a
  money dispute and a pricing gap reach the same place. Fine for one business;
  revisit if this is resold.
- **`assigned_to` is unused.** The column exists for a queue UI that does not
  exist yet; today an escalation belongs to whoever gets to the inbox first.
- **No reranker.** The plan called for retrieve-20-then-rerank with Cohere,
  which is usually a bigger quality jump than any prompt tweak. Hybrid fusion
  is in; the rerank step is not, and is the obvious next improvement if
  retrieval quality disappoints.
- **Retrieval quality is untested against real content.** The 19 tests prove
  the plumbing — determinism, staleness, fusion, the guards. Whether six chunks
  is the right `top_k` for your knowledge base is a question only real traffic
  answers.
