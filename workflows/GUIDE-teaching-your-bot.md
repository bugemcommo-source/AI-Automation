# Teaching your bot

A guide for whoever looks after the knowledge base. No technical background
needed. You will not break anything — the system is built to stop you.

---

## What the bot actually is

Your bot is not clever. It does not know anything about your business except
what you write down.

Everything it can say lives in one list you control. When a customer asks a
question, the bot reads your whole list and answers from it. If the answer is
not in the list, **it says so and asks a person to step in.** It never guesses
a price, an opening time, or a policy.

So when the bot gets something wrong, the fix is almost never technical. The
fix is usually: the answer was missing, or it was written unclearly.

You fix that yourself, and the bot knows it from the very next message. Nothing
gets deployed. Nobody gets called.

---

## Your three screens

You work in a tool called NocoDB. It looks like a spreadsheet. You will see
three things:

| Screen | What it is |
| --- | --- |
| **kb_editor** | Everything the bot knows. This is where you spend your time. |
| **queue_editor** | Questions the bot could not answer. Your to-do list. |
| **rules_editor** | Topics that always go to a person, never the bot. |

You cannot see customer conversations from here, and that is on purpose.

---

## Your weekly routine

This is the whole job. Fifteen minutes, once a week.

### 1. Open **queue_editor**

Every row is a real customer question your bot could not answer. It is a
to-do list that writes itself, ordered by what people actually ask.

Look at the **Still waiting** and **Overdue** columns first — those are people
who have not had a reply yet.

### 2. Answer the ones that keep coming up

If three people asked about parking this week, that is worth writing down. If
one person asked something very unusual, it probably is not.

### 3. Add the answer in **kb_editor**

Click new row. Fill in:

| Column | What to put |
| --- | --- |
| **Question or topic** | A short label, so you can find it later. "Parking" |
| **Answer** | The answer, written the way you would say it out loud |
| **Category** | Roughly what it is about. "general", "pricing", "services" |
| **Status** | `draft` while you are writing, `published` when it is ready |
| **Order** | Leave it. Only matters if you want something read first. |

### 4. Change Status to `published`

That is it. The bot can answer that question from the next message onwards.

---

## The one thing to remember: draft vs published

**The bot only ever reads rows marked `published`.**

This is your safety net. You can leave something half-written as a `draft` for
a week and no customer will ever see it. Nothing goes live until you say so.

If you are ever unsure — set it to `draft`. You can always publish later.

---

## How to write a good answer

The difference between a bot people like and a bot people complain about is
almost entirely in how these are written.

**Write it the way you would say it.** Not the way a brochure says it.

> ❌ "Our establishment offers premium deep tissue therapeutic services."
> ✅ "Deep tissue is ₱1,800 for 60 minutes, ₱2,500 for 90 minutes."

**One topic per row.** A row that covers pricing *and* opening hours *and*
parking will answer all three questions vaguely. Three separate rows answer all
three well.

**Write down the "no" answers too.** This is the one most people miss.

> "We do not accept HMO cards for any service."

If that sentence is not written down, a customer asks about HMO, the bot finds
nothing, and hands it to a person. Which is fine — but writing it once means
the bot handles it instantly, forever.

**Include the words customers actually use.** If people say "hilot" and you
wrote "massage", add both. If they say "magkano" and you wrote "price", put
both in. The bot matches meaning, but real words help.

---

## When the bot should never answer

Some things should always go to a person, no matter how well you have written
the knowledge base. Those live in **rules_editor**.

It comes set up already for: someone asking to speak to a person, refunds and
payment complaints, cancellations, questions about an existing booking, medical
or safety questions, and anything legal or press.

To add your own, make a new row:

| Column | What to put |
| --- | --- |
| **Rule name** | Something you will recognise. "GCash problems" |
| **Words to watch for** | The words, separated by `\|` — `gcash\|g-cash\|gcash refund` |
| **Why** | A short label. "money_dispute" |
| **On** | Tick it |

The `|` character means "or". So `gcash|maya|paymaya` catches all three.

**Keep the words specific.** If you write something too broad, every single
message would go to a person and nobody would get an instant answer. The system
will refuse to save a rule that does that, and tell you why.

---

## Things that will stop you (on purpose)

You will see a red error message if you try to:

| What you did | What it says |
| --- | --- |
| Publish an answer that is empty or one word | *"The answer for X is too short to publish."* |
| Publish with no title | *"Give this a title before publishing it."* |
| Save a rule with unmatched brackets | *"...check for an unclosed ( or [."* |
| Save a rule that would catch everything | *"...would match every message ever sent."* |

These are not bugs. Each one is stopping a change that would have affected
every customer. Read the message, fix the row, save again.

---

## Checking how it is going

Ask whoever set this up to show you these, or run them yourself if you have
database access:

- **Answer rate** — what share of questions the bot handled without a person.
  Expect 50–65% at the start, and 80%+ after a few weeks of you working the
  queue. If it is stuck low, the knowledge base has gaps.
- **The queue length** — if it keeps growing, either the knowledge base needs
  work or nobody is answering escalations.
- **Response time** — how long customers wait once the bot hands over.

---

## When a customer gets handed to a person

The bot stops talking on that conversation and waits.

**You reply in the normal Facebook Page inbox.** Exactly as you would have
before any of this existed. Nothing special to open, no extra app.

The system notices you replied, and stays quiet so it never talks over you.
Once the conversation has been finished for a day, the bot quietly picks that
customer back up for next time.

If nobody replies within 15 minutes, the system chases whoever is on duty. It
keeps chasing, roughly once an hour, until someone answers. A customer who was
promised a person is never quietly forgotten.

---

## Questions people usually ask

**Will the bot make something up?**
It is instructed not to, and it is only given your published rows to work
from. If the answer is not there, it says a person will follow up rather than
guessing. That is why writing down your "no" answers matters.

**What if I make a mistake in an answer?**
Fix the row and save. It takes effect on the next message. Every edit is
recorded with who made it and when, so a wrong price can always be traced.

**Can I delete something?**
Set Status to `archived` instead. It disappears from the bot and from your
list, but the history stays.

**Does the bot speak Tagalog?**
Yes, and Taglish, and it switches mid-conversation if the customer does. Write
your answers in whichever language you would actually use.

**Can I turn the whole thing off?**
Yes — whoever set it up can deactivate the workflow. The Page inbox keeps
working exactly as normal.
