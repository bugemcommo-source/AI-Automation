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
| **G** Dashboard | `GET /webhook/dashboard` | Renders one HTML page from all seven tables, or exports JSON/CSV |
| **H** Publish | the publish form's public URL | Mints one tracked link per platform and fans the post out |

## How the seven branches connect

They don't — not on the canvas. Seven triggers means seven independent
executions, and n8n cannot route one trigger's run into another's. Every
branch converges instead on the **shared data tables**, and branch G reads
them all back. The coupling is real; it just isn't drawable.

```
A ─┐
B ─┤
C ─┼──▶  click_events · contacts · messages · bookings         ┌──▶ HTML page
D ─┤     payments · notifications · ops_events   ──▶ G9 ─ G10 ─┼──▶ JSON
E ─┤                                                           └──▶ CSV
F ─┘
```

`faq` is the eighth table — reference data the chat agent reads, never an
output, so it is deliberately not on the dashboard.

## Dashboard exports

`G9` computes every aggregate once, then `G10` routes on `?format=` so the three
formats can never drift apart:

| Request | Serves | Built for |
| --- | --- | --- |
| `/webhook/dashboard` | the HTML page | humans |
| `?format=json` | all five datasets in one object | Power BI **Web** connector, Looker Studio |
| `?format=csv` | CSV of one dataset | Salesforce, GoHighLevel |

For CSV, `?dataset=` picks the table — `leads` (the default), `events`,
`funnel` or `posts`. An unrecognised `format` falls back to the page rather
than erroring.

`leads` is the default because that is what a CRM ingests. It carries a
`lead_type` covering both ways a person goes cold:

- `stalled_booking` — reached the form, never paid
- `chatted_no_booking` — clicked and chatted, never opened the form

`preferred_channel` is already resolved to `sms`, `email` or the chat platform,
so the import maps straight onto a follow-up campaign. `events` is the
flat fact table — one row per click, booking, message, notification and
failure, with a `fact_type` discriminator — which is the shape BI tools model
best.

Salesforce and GoHighLevel *pushes* would need real credentials; CSV pull-in
needs none, which is why the simulation stops there.

## The third-party apps are on the canvas, switched off

Slack, Telegram, Google Calendar, Stripe, Gmail, Twilio and Salesforce all sit
in the flow with their real branding and their fields already mapped. Every one
is **disabled**.

n8n skips a disabled node and passes its input straight through, so the apps
can live in the live path without a credential, a sign-in or an outbound call —
and the simulation still runs green end to end. Going live is: enable the node,
add the credential. No rewiring.

| App | Node | Replaces |
| --- | --- | --- |
| Slack | `A4 Alert` | nothing — adds failure alerts |
| Telegram | `C12a Send Reply` | C13's JSON response |
| Google Calendar | `D3b Availability` | D3a's `slots` lookup |
| Stripe | `E5a Get Charge` | E5's invented payment |
| Google Calendar | `E8b Create Event` | E8a's `slots` write |
| Gmail | `E9a Send Receipt` | E9's pretend email |
| Twilio | `E9b Send SMS` | E9's pretend SMS |
| Twilio | `F4a Chase SMS` | F4's pretend chase |
| Gmail | `F4b Chase Email` | F4's pretend chase |
| Salesforce | `G12a Create Lead` | the CSV export |

### Social platforms — branch H (9)
Facebook, Instagram, X, LinkedIn, WhatsApp, Discord, Reddit, Telegram, TikTok.
Each receives the same caption with **its own tracked link** appended, so a
click traces back to the platform it came from. Instagram and TikTok ship no
dedicated n8n node — Instagram goes through the Facebook Graph API, TikTok
through the Content Posting API, which is how you integrate them for real.

### CRM and spreadsheet destinations — off `G12` (5)
Salesforce, GoHighLevel, HubSpot, Pipedrive, Google Sheets. All receive the
same `leads` rows the CSV export contains. GoHighLevel ships no n8n node, so
it is an HTTP Request against the LeadConnector API.

### Database destinations — off `G12` (5)
Postgres, MySQL, MongoDB, Airtable, Supabase — what the eleven data tables
become at scale.

### A note on colour
n8n renders **disabled nodes desaturated**, and node icons come from the node
type — neither is overridable. So identification is carried by sticky colour
instead, which is under our control: 🟢 green for social publishing, 🟠 orange
for CRM, 🔵 blue for databases, purple for messaging, calendar and payments.

Each hangs off the same parent as the simulated node it mirrors, rather than
sitting in series with it. That way the pairing is visible and they can be
enabled one at a time without unplugging anything.

Power BI and Looker Studio need no node at all — they read `?format=json` from
the dashboard endpoint directly. GoHighLevel drops in exactly where Salesforce
does.

## What is simulated

- **The calendar** — a real `slots` table that `D3a` and `E2a` both read.
  A slot is taken if it is `booked`, or `held` with `hold_expires_at` still in
  the future; an absent row means free. Swap `D3a`/`E2a` for Google Calendar
  to go live.
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
| `slots` | the calendar — one row per taken slot, `held` or `booked` |
| `social_post_log` | the publish record — one row per post **per platform** |
| `ops_events` | every failure |

All seven are read back by branch G. `payments` and `contacts` were write-only
dead ends until they were wired in — which meant revenue never appeared on the
dashboard, and anyone who chatted but never opened the booking form was
invisible to the follow-up list.

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
- **D** — a slot already `booked` ends the form politely, saying why, with
  nothing charged; a free slot writes the booking at `form_submitted` and
  holds the slot for 20 minutes.
- **E** — success confirms the booking, records the payment, mints the
  calendar id, marks the slot `booked` and logs receipt + SMS; an unknown
  `booking_id` returns `not_found` without touching money.
- **The race** — a booking whose hold lapsed, whose slot was then taken by
  someone else, returns `slot_lost_refunded` naming the booking that took it,
  and writes no payment. This is the path that could not fire before.
- **Hold expiry** — a slot held by a stalled booking past its expiry is
  reclaimed by the next person to ask for it.
- **F** — chases a 24h-stalled booking by SMS and stamps `chase_count`; the
  next sweep finds nothing and stops cleanly.
- **G** — counts reconcile against the tables; `?format=json` returns all five
  datasets, `?format=csv` defaults to leads, `?dataset=` selects correctly, and
  an unknown format falls back to the page.
- **A** — a simulated failure lands in `ops_events` with node, message and
  execution URL intact.
- **Every branch again, with the app nodes in place** — all thirty report
  `executionTime: 0` and pass their input through untouched, and every branch
  still produces exactly the same rows it did before they were added.
- **The loop closes** — branch H published `post_005` with nine tracked links,
  and branch B logged a click on that exact post with an exact-attribution
  token. Publish and click are now two ends of one measurable path.

## The publish record

`H2b Log Post` writes one row per post **per platform** into `social_post_log`:

| Column | Holds |
| --- | --- |
| `post_id`, `platform`, `posted_at` | what went where, when |
| `text_sent`, `char_count`, `char_limit`, `truncated` | the exact caption sent, measured against that platform's limit |
| `link` | the tracked link that post carries |
| `status`, `remote_ref`, `error` | delivery outcome |

`H2` applies each platform's real character limit — X 280, Discord 2000,
Instagram and TikTok 2200, LinkedIn 3000, WhatsApp and Telegram 4096 — and
truncates the caption to fit **while preserving the link intact**, flagging
`truncated`. Verified: a 389-character caption comes out at exactly 280 for X
with the link whole, and untouched on Facebook.

The dashboard's `posts` dataset is now **led by the publish log with clicks
left-joined onto it**, not a group-by over clicks. Before this, a post nobody
clicked did not exist in any output. Now every published post appears with its
caption, platform count, publish date, truncation count and click total —
including the zeroes, which are the ones worth knowing about. A post that has
clicks but no publish row shows as `(not in publish log)` rather than being
silently merged away.

One honest limitation: the log is written **before** the platform nodes, so it
records intent (`status: simulated`) rather than outcome. That is correct while
the platforms are disabled. Enabling a real platform means moving this node
downstream of it to capture the actual `remote_ref` — noted on the node card.

## Redundancy removed

`D5`, `E7` and `F6` each rebuilt the identical 21-field bookings row — zero
field differences between them. That is why the empty-string date bug had to
be fixed in three places.

`E7` and `F6` now emit only the columns they actually change and their data
table nodes use `update` rather than `upsert`, so neither can clobber a column
it does not own. `D5` remains the only full-row builder, because it is the
insert. `E9` and `E11` read the booking from `E3`, the one place it is loaded.

`hashOf` used to be defined three times, and the `D3`/`E3` pair was the
dangerous one: two copies of a function that had to stay byte-identical or the
race guard would disagree with the availability check. Both are now gone —
`D3a` and `E2a` read the same `slots` row instead, because a real calendar is
shared state, not a shared function. The one remaining `hashOf` lives in `B3`,
where it anonymises IP addresses and has nothing to do with availability.

Removing it exposed something worse than duplication. Because both copies were
pure functions of `slot_start`, they could never disagree — which meant
`slot_lost_refunded` was **unreachable code**. The guard looked right and did
nothing. Reading shared state made it real: the branch now fires, and has been
observed firing.

## Two bugs this shook out

**Empty string into a date column.** `bookings` types six columns as dates,
and the data table node rejects `''` for those. `D5`, `E7` and `F6` now emit
`null` for an absent date.

**CSV quoting.** The `events` dataset carries message bodies containing commas
(`4,500 PHP`) and embedded newlines. Verified against live data: those fields
come out wrapped in quotes with the newlines preserved, plain fields stay
unquoted — valid RFC 4180, so a CRM importer will not shear rows apart.

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
