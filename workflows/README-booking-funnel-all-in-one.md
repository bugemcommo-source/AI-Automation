# Booking Funnel — All in One (Simulated)

One n8n workflow, 126 nodes, seven independent branches, zero credentials.
Everything a social-to-booking funnel needs — tracked links, a chatbot, a
booking form, a deposit, receipts, follow-up nurture, error logging and a
dashboard — on a single canvas.

**Workflow:** `TrCfAqLIaIkFAUK2`
**Source:** [`booking-funnel-all-in-one.ts`](./booking-funnel-all-in-one.ts)

## The seven branches

Each branch has its own trigger, so each runs as an isolated execution and
they never interfere with one another.

| Branch | Entry point | What it does |
| --- | --- | --- |
| **A** Error handler | Error Trigger (this workflow's own failures) | Flattens the error into an `ops_events` row |
| **B** Click router | `GET /webhook/go?p=post_001&c=telegram` | Mints an attribution token, builds the chat deep link, logs the click, 302s |
| **C** Chat + agent | `POST /webhook/chat` | Trades the token for the click row, answers from the `faq` table, logs both sides |
| **D** Booking form | the form trigger's public URL | Checks the slot, holds it, shows a simulated deposit link |
| **E** Payment callback | `GET /webhook/pay?booking_id=…&outcome=success` | Re-checks the slot, records payment, sends receipt + SMS |
| **F** Nurture sweep | hourly schedule | Chases bookings stalled over 24h, exactly once each |
| **G** Dashboard | `GET /webhook/dashboard` | Renders one HTML page from all five tables |

## What is simulated

- **The calendar** — deterministic: a slot is busy when its hash mod 4 is
  zero, so the same slot always answers the same way. Swap `D3` and `E3` for
  Google Calendar to go live.
- **The payment** — a link carrying `outcome=success` or `outcome=fail`.
  Swap `E1` for the Stripe Trigger.
- **The receipt and SMS** — rows written to `notifications` as if delivered.
  Swap `E9` for Gmail + Twilio.
- **The LLM** — keyword scoring against the `faq` table, with a score
  threshold below which it says it doesn't know rather than guessing.

## Two things worth knowing

**Attribution is exact only where the platform allows it.** Telegram
(`?start=`) and Messenger (`?ref=`) hand the token back verbatim. WhatsApp
carries it in editable prefill text, so it can be deleted. Instagram's
`ig.me` links take no parameter at all — those clicks are inferred, and the
`attribution` column says so on every row.

**Organic social posts cannot have real buttons.** Only ads can. The
mechanism here is a tracked link in the caption plus a 302 redirect, which
is what everyone else is doing too.

## Data tables

| Table | Holds |
| --- | --- |
| `click_events` | one row per tracked-link click, with the attribution token |
| `contacts` | one row per person per platform |
| `messages` | both sides of every conversation |
| `faq` | the knowledge base — editing an answer is editing a row |
| `bookings` | the funnel stage machine |
| `payments` | deposits, simulated |
| `notifications` | every email and SMS "sent" |
| `ops_events` | every failure |

## Reading the canvas

The canvas ships documented. A **README panel** sits above the workflow, a
**band header** introduces each branch, and every one of the 60 functional
nodes has a **card** beneath it naming what it takes in, what it does, and
what it emits. Cards marked 👉 are the ones you edit; 🔧 marks the nodes you
swap to go live; ⚠️ and 🔁 flag the nodes carrying a deliberate failure
setting.

## Verified behaviour

Every branch was run against the live instance, both sides of every `If`:

- **B** — telegram click logged with an exact-attribution token; an unknown
  channel (`c=tiktok`) 404s without logging; `facebookexternalhit` is
  flagged `is_bot`, not dropped.
- **C** — `/start <token>` resolved the click to `post_002`, created the
  contact and sent the welcome; a follow-up question matched FAQ `F002` at
  0.5, offered the booking link, and kept the original post credited.
- **D** — a busy slot ends the form politely with nothing charged; a free
  slot writes the booking at `form_submitted` with the hold expiry set.
- **E** — success confirms the booking, records the payment, mints the
  calendar id and logs receipt + SMS; an unknown `booking_id` returns
  `not_found` without touching money.
- **F** — chases a 24h-stalled booking by SMS and stamps `chase_count`; the
  next sweep finds nothing and stops cleanly.
- **G** — counts reconcile against the tables.
- **A** — a simulated failure lands in `ops_events` with node, message and
  execution URL intact.

## Two bugs this shook out

**Empty string into a date column.** `bookings` types six columns as dates,
and the data table node rejects `''` for those. `D5`, `E7` and `F6` now emit
`null` for an absent date.

**Chained reads multiplying each other.** `G2`–`G6` run in series, so each
one ran once per item the previous read returned and the dashboard counted
the cartesian product — 2 bookings showed as 6, 3 notifications as 180.
`executeOnce` on `G3`–`G6` makes each read run a single time.

## The tradeoff

One workflow means activation is all-or-nothing: you cannot pause the hourly
sweep without also taking down the webhooks, and one bad deploy takes every
branch with it. That is the right call for a simulation and the wrong one
once real money moves through it — split the branches into separate
workflows before that happens.
