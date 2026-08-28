# Messenger Knowledge Bot

A Facebook Page that answers customer messages from a knowledge base the business
owner controls — grounded in that knowledge, escalating to a human when it isn't,
and rate-limited so a bad actor cannot run up the model bill.

**Source:** [`messenger-knowledge-bot.ts`](./messenger-knowledge-bot.ts) (n8n Workflow SDK)
**Schema:** [`../db/001_messenger_bot_schema.sql`](../db/001_messenger_bot_schema.sql)
**Tests:** [`../db/002_schema_tests.sql`](../db/002_schema_tests.sql)

This is Phases 2 and 3 of the build plan. There is deliberately **no vector
database** — see [Why no RAG yet](#why-there-is-no-vector-database-yet).

## The three flows

Three independent triggers, so each runs as its own execution and none can take
the others down.

| Flow | Entry point | What it does |
| --- | --- | --- |
| **A** Verify | `GET /webhook/fb-messenger-bot` | Answers Meta's one-time webhook challenge |
| **B** Conversation | `POST /webhook/fb-messenger-bot` | The bot. One inbound message, end to end |
| **C** CRM sync | hourly schedule | Pushes contacts and transcripts into GoHighLevel |

Both webhooks share one path because Meta requires the same URL for verification
and for events; only the HTTP method differs.

```
A1 Verify (GET) → A2 Check Token → A3 Respond Challenge

B1 Inbound (POST) ─┬→ B2 Ack Meta 200                    (parallel, immediate)
                   │
                   └→ B3 HMAC → B4 Verify + Normalize → B5 Filter
                        → B6 bot_gate() → B7 Allowed?
                             ├ false → B8 Stop (already logged)
                             └ true  → B9 Typing → B10 Knowledge → B11 Context
                                       → B12 Claude → B13 Verdict → B14 Log
                                       → B15 Send → B16 Answered?
                                                     ├ true  → B17 Done
                                                     └ false → B18 Alert owner

C1 Hourly → C2 Find unsynced → C3 Loop ─→ C4 Upsert ─┬→ C5 Note → C6 Save ID
                                                      └→ C7 Record failure
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

## Security posture

| Control | Where |
| --- | --- |
| `X-Hub-Signature-256` verified against the App Secret over the **raw** body | B3 + B4 |
| Non-Messenger requests rejected with no execution created | B1 `onlyRunIf` |
| `is_echo` filtered, so the bot cannot answer itself in a loop | B4 |
| Replays deduped on `mid` (UNIQUE index) | B6 |
| Customer text wrapped in `<customer_message>` and declared non-instructional | B12 |
| Bot has **no tools** — it can read knowledge and write a log, nothing else | B12 |
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

## Setup

### 1. Database

```bash
psql "$SUPABASE_DB_URL" -f db/001_messenger_bot_schema.sql
```

Change `CHANGE_ME_BOT` and `CHANGE_ME_EDITOR` in Section 8 first, or `ALTER ROLE`
straight afterwards. To verify the guards behave, run the tests against a
**scratch database** — they write rows, block contacts and rewrite limits:

```bash
psql "$SCRATCH_DB_URL" -f db/001_messenger_bot_schema.sql
psql "$SCRATCH_DB_URL" -f db/002_schema_tests.sql
```

All 18 pass on Postgres 16.

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
- **The 24-hour window is not enforced in code.** Flow B only ever replies to an
  inbound message, so it is always inside the window. Any *outbound-initiated*
  follow-up added later must check `conversations.last_message_at` first.
- **No human-handoff release.** Setting `conversations.status` back to `'bot'`
  is a manual `UPDATE` today. It wants a button in whatever the team answers
  escalations from.
- **Attachments are acknowledged, not read.** Images and voice notes get a canned
  reply asking for words.
