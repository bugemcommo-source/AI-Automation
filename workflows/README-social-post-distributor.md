# Social Post Distributor

Compose a post once, fan it out to six platforms, and log every delivery — including
the failures.

- **n8n workflow:** `0X7vpgIi6bEdQzEl`
- **Source of truth:** `social-post-distributor.ts` (n8n Workflow SDK)
- **Storage:** `social_post_submissions` (`0W6q2t2dk4taRTMN`) and `social_post_log` (`si7SiekpdNY6mYOr`)
- **Status:** inactive, and **cannot run until credentials are added** — see below

## Flow

```
Compose Post (form)
  → Normalize Submission
  → Store Submission          ← raw input saved before anything is sent
  → Expand to Targets         ← 1 item per selected platform, trimmed to its limit
  → Route by Platform (switch)
        X · LinkedIn · Facebook · Telegram · Discord · Reddit
        each → Record <platform> Result
  → Collect Delivery Results (merge, 6 inputs)
  → Log Delivery
  → Show Result (completion page)
```

## Character ceilings

`Expand to Targets` trims each copy to the platform's real limit and preserves the
link at the end. When it trims, the row carries `truncated: true`, so the log never
implies the full text went out.

| Platform | Limit |
|---|---|
| X | 280 |
| Discord | 2,000 |
| LinkedIn | 3,000 |
| Telegram | 4,096 |
| Reddit | 40,000 |
| Facebook | 63,206 |

## Failure isolation

Every platform node uses `onError: continueRegularOutput`. One platform failing
produces an error item on that branch only — the others still publish, and the
failure is written to `social_post_log` with `status: failed` and the error text.

Each branch records its own outcome rather than inferring platform from the API
response, so attribution in the log is never a guess.

## Before it can run

Add these in the n8n UI (Settings → Credentials). Connect only what you need —
unselected platforms never execute.

| Platform | Credential type | Also needs |
|---|---|---|
| X | `twitterOAuth2Api` | — |
| LinkedIn | `linkedInOAuth2Api` | your person URN |
| Facebook | `facebookGraphApi` | your Page ID |
| Telegram | `telegramApi` | your chat / channel ID |
| Discord | `discordBotApi` | server + channel (pickers) |
| Reddit | `redditOAuth2Api` | subreddit + title, entered per post |

**Instagram and Mastodon have no n8n node.** Instagram posting is only possible
through the Facebook Graph API with a Business account linked to a Page — it is a
different flow (create a media container, then publish it), not a drop-in seventh
branch.

## Verified

Tested with X + LinkedIn + Telegram selected, platform nodes pinned:

- 3 items produced, one per selected platform; Facebook, Discord and Reddit branches
  correctly received nothing
- X trimmed to exactly 280 characters with the link intact and `truncated: true`
- LinkedIn and Telegram passed through at 435 characters, untrimmed
- Each result attributed to the right platform with the right remote reference
  (tweet id, LinkedIn URN, Telegram `message_id`)
- 1 raw submission row and 3 delivery rows written

The execution ends in `waiting` state at the completion page — that is normal for
n8n form workflows, which hold the run open for the browser to collect the result.
