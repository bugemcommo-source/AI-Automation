# Messenger Knowledge Bot

A Facebook Page that answers customer messages from a knowledge base the business
owner controls — grounded in that knowledge, escalating to a human when it isn't,
and rate-limited so a bad actor cannot run up the model bill.

**Source:** [`messenger-knowledge-bot.ts`](./messenger-knowledge-bot.ts) (n8n Workflow SDK)
**Schema:** [`001`](../db/001_messenger_bot_schema.sql) · [`003`](../db/003_phase4_escalation.sql)
**Tests:** [`002`](../db/002_schema_tests.sql) (18) · [`004`](../db/004_phase4_tests.sql) (18)

This is Phases 2, 3 and 4 of the build plan. There is deliberately **no vector
database** — see [Why no RAG yet](#why-there-is-no-vector-database-yet).

## The four flows

Four independent triggers, so each runs as its own execution and none can take
the others down.

| Flow | Entry point | What it does |
| --- | --- | --- |
| **A** Verify | `GET /webhook/fb-messenger-bot` | Answers Meta's one-time webhook challenge |
| **B** Conversation | `POST /webhook/fb-messenger-bot` | The bot. One inbound message, end to end |
| **C** CRM sync | hourly schedule | Pushes contacts and transcripts into GoHighLevel |
| **D** SLA sweep | every 10 minutes | Chases unanswered escalations, returns finished threads to the bot |

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
```

Change `CHANGE_ME_BOT` and `CHANGE_ME_EDITOR` in Section 8 first, or `ALTER ROLE`
straight afterwards. To verify the guards behave, run the tests against a
**scratch database** — they write rows, block contacts and rewrite limits:

```bash
psql "$SCRATCH_DB_URL" -f db/001_messenger_bot_schema.sql
psql "$SCRATCH_DB_URL" -f db/003_phase4_escalation.sql
psql "$SCRATCH_DB_URL" -f db/002_schema_tests.sql
psql "$SCRATCH_DB_URL" -f db/004_phase4_tests.sql
```

36 tests, all passing on Postgres 16. Both files are re-runnable.

### 2. Credentials

Five, all named on the nodes:

| Credential | Type | Holds |
| --- | --- | --- |
| `Meta App Secret` | Crypto | App Secret, for the HMAC. **Not** the Page token |
| `Meta Page Access Token` | HTTP Templated Custom Auth | `{"headers":{"Authorization":"Bearer {{api_key}}"}}` |
| `Supabase — bot_role` | Postgres | `bot_role` connection string |
| `Anthropic` | Anthropic | Anthropic API key |
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

## Why there is no vector database yet

A knowledge base for one business is realistically 8,000–40,000 tokens. Claude
Opus 5 holds a million, and prompt caching makes re-reading it cheap. So the
whole base goes into the system prompt on every message.

The model sees *everything* rather than a guessed top-five chunks, which is why
it handles compound questions ("how much is a deep tissue and are you open
Sunday?") that break naive retrieval. There is no chunking to tune, no embedding
drift, no re-indexing job.

Add retrieval when one of these is true:

- The knowledge base passes ~100,000 tokens and the Claude line starts to hurt
- Hundreds of products or SKUs with individual detail
- Content changes several times a day, so the cache keeps invalidating
- **You resell this to multiple clients** — the trigger most likely to fire

`kb_documents.embedding_stale` and the commented `kb_chunks` table at the bottom
of the schema are already shaped for it, so Phase 6 is additive rather than a
migration.

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
