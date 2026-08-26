import { workflow, node, trigger, sticky, switchCase, merge, newCredential, placeholder, expr } from '@n8n/workflow-sdk';

const composeForm = trigger({
  type: 'n8n-nodes-base.formTrigger',
  version: 2.6,
  config: {
    name: 'Compose Post',
    position: [0, 0],
    parameters: {
      formTitle: 'Publish to your channels',
      formDescription: 'Write once. Pick where it goes. Every delivery is logged, including the failures.',
      responseMode: 'lastNode',
      formFields: {
        values: [
          { fieldLabel: 'Post text', fieldType: 'textarea', requiredField: true, placeholder: 'What do you want to say?' },
          { fieldLabel: 'Link', fieldType: 'text', requiredField: false, placeholder: 'https://example.com (optional)' },
          {
            fieldLabel: 'Platforms',
            fieldType: 'dropdown',
            multiselect: true,
            requiredField: true,
            fieldOptions: {
              values: [
                { option: 'X' }, { option: 'LinkedIn' }, { option: 'Facebook' },
                { option: 'Telegram' }, { option: 'Discord' }, { option: 'Reddit' }
              ]
            }
          },
          { fieldLabel: 'Subreddit', fieldType: 'text', requiredField: false, placeholder: 'e.g. n8n (Reddit only)' },
          { fieldLabel: 'Reddit title', fieldType: 'text', requiredField: false, placeholder: 'Required if posting to Reddit' }
        ]
      },
      options: { appendAttribution: false, buttonLabel: 'Publish', ignoreBots: true }
    }
  },
  output: [{ 'Post text': 'Shipping a new release today.', Link: 'https://example.com/release', Platforms: ['X', 'Telegram'], Subreddit: '', 'Reddit title': '' }]
});

const normalize = node({
  type: 'n8n-nodes-base.set',
  version: 3.5,
  config: {
    name: 'Normalize Submission',
    position: [360, 0],
    parameters: {
      mode: 'manual',
      includeOtherFields: false,
      assignments: {
        assignments: [
          { id: 'n-id', name: 'post_id', value: expr('{{ "P" + $now.toFormat("yyyyLLdd-HHmmss") }}'), type: 'string' },
          { id: 'n-at', name: 'submitted_at', value: expr('{{ $now.toISO() }}'), type: 'string' },
          { id: 'n-text', name: 'post_text', value: expr('{{ $json["Post text"] ?? "" }}'), type: 'string' },
          { id: 'n-link', name: 'link', value: expr('{{ $json["Link"] ?? "" }}'), type: 'string' },
          { id: 'n-plat', name: 'platforms', value: expr('{{ (Array.isArray($json["Platforms"]) ? $json["Platforms"].join(",") : String($json["Platforms"] ?? "")).toLowerCase() }}'), type: 'string' },
          { id: 'n-sub', name: 'reddit_subreddit', value: expr('{{ $json["Subreddit"] ?? "" }}'), type: 'string' },
          { id: 'n-title', name: 'reddit_title', value: expr('{{ $json["Reddit title"] ?? "" }}'), type: 'string' }
        ]
      }
    }
  },
  output: [{ post_id: 'P20260826-104500', submitted_at: '2026-08-26T10:45:00.000Z', post_text: 'Shipping a new release today.', link: 'https://example.com/release', platforms: 'x,telegram', reddit_subreddit: '', reddit_title: '' }]
});

const storeSubmission = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Store Submission',
    position: [720, 0],
    parameters: {
      resource: 'row',
      operation: 'insert',
      dataTableId: { __rl: true, mode: 'list', value: '0W6q2t2dk4taRTMN', cachedResultName: 'social_post_submissions' },
      columns: { mappingMode: 'autoMapInputData', value: null, matchingColumns: [] }
    }
  },
  output: [{ id: 1, createdAt: '2026-08-26T10:45:00.000Z', updatedAt: '2026-08-26T10:45:00.000Z' }]
});

const expandTargets = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Expand to Targets',
    position: [1080, 0],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const s = $('Normalize Submission').first().json;

const LIMITS = { x: 280, linkedin: 3000, facebook: 63206, telegram: 4096, discord: 2000, reddit: 40000 };
const NAMES = { x: 'X', linkedin: 'LinkedIn', facebook: 'Facebook', telegram: 'Telegram', discord: 'Discord', reddit: 'Reddit' };
const ORDER = ['x', 'linkedin', 'facebook', 'telegram', 'discord', 'reddit'];

const chosen = String(s.platforms || '')
  .split(',')
  .map(function (p) { return p.trim().toLowerCase(); })
  .filter(function (p) { return LIMITS[p] !== undefined; });

const body = String(s.post_text || '').trim();
const link = String(s.link || '').trim();

const out = [];
ORDER.forEach(function (p) {
  if (chosen.indexOf(p) === -1) { return; }

  const limit = LIMITS[p];
  const suffix = link ? ' ' + link : '';
  let text = body + suffix;
  let truncated = false;

  if (text.length > limit) {
    truncated = true;
    const room = limit - suffix.length - 1;
    text = body.slice(0, room > 0 ? room : 0).trimEnd() + '\\u2026' + suffix;
    if (text.length > limit) { text = text.slice(0, limit); }
  }

  out.push({
    json: {
      post_id: s.post_id,
      platform: p,
      platform_name: NAMES[p],
      text: text,
      char_count: text.length,
      char_limit: limit,
      truncated: truncated,
      link: link,
      reddit_subreddit: s.reddit_subreddit || '',
      reddit_title: s.reddit_title || ''
    }
  });
});

return out;`
    }
  },
  output: [
    { post_id: 'P20260826-104500', platform: 'x', platform_name: 'X', text: 'Shipping a new release today. https://example.com/release', char_count: 57, char_limit: 280, truncated: false, link: 'https://example.com/release', reddit_subreddit: '', reddit_title: '' }
  ]
});

const routePlatform = switchCase({
  version: 3.4,
  config: {
    name: 'Route by Platform',
    position: [1440, 0],
    parameters: {
      mode: 'rules',
      rules: {
        values: [
          { renameOutput: true, outputKey: 'X', conditions: { options: { caseSensitive: false, leftValue: '', typeValidation: 'loose' }, conditions: [{ leftValue: expr('{{ $json.platform }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'x' }], combinator: 'and' } },
          { renameOutput: true, outputKey: 'LinkedIn', conditions: { options: { caseSensitive: false, leftValue: '', typeValidation: 'loose' }, conditions: [{ leftValue: expr('{{ $json.platform }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'linkedin' }], combinator: 'and' } },
          { renameOutput: true, outputKey: 'Facebook', conditions: { options: { caseSensitive: false, leftValue: '', typeValidation: 'loose' }, conditions: [{ leftValue: expr('{{ $json.platform }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'facebook' }], combinator: 'and' } },
          { renameOutput: true, outputKey: 'Telegram', conditions: { options: { caseSensitive: false, leftValue: '', typeValidation: 'loose' }, conditions: [{ leftValue: expr('{{ $json.platform }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'telegram' }], combinator: 'and' } },
          { renameOutput: true, outputKey: 'Discord', conditions: { options: { caseSensitive: false, leftValue: '', typeValidation: 'loose' }, conditions: [{ leftValue: expr('{{ $json.platform }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'discord' }], combinator: 'and' } },
          { renameOutput: true, outputKey: 'Reddit', conditions: { options: { caseSensitive: false, leftValue: '', typeValidation: 'loose' }, conditions: [{ leftValue: expr('{{ $json.platform }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'reddit' }], combinator: 'and' } }
        ]
      },
      options: { looseTypeValidation: true }
    }
  }
});

const postX = node({
  type: 'n8n-nodes-base.twitter',
  version: 2,
  config: {
    name: 'Post to X',
    position: [1800, 420],
    onError: 'continueRegularOutput',
    parameters: { resource: 'tweet', operation: 'create', text: expr('{{ $json.text }}') },
    credentials: { twitterOAuth2Api: newCredential('X / Twitter') }
  },
  output: [{ id: '1799999999999999999', text: 'Shipping a new release today.' }]
});

const postLinkedIn = node({
  type: 'n8n-nodes-base.linkedIn',
  version: 1,
  config: {
    name: 'Post to LinkedIn',
    position: [1800, 840],
    onError: 'continueRegularOutput',
    parameters: {
      resource: 'post',
      operation: 'create',
      postAs: 'person',
      person: placeholder('Pick your LinkedIn person URN once the credential is connected'),
      text: expr('{{ $json.text }}'),
      shareMediaCategory: 'NONE',
      additionalFields: { visibility: 'PUBLIC' }
    },
    credentials: { linkedInOAuth2Api: newCredential('LinkedIn') }
  },
  output: [{ urn: 'urn:li:share:7000000000000000000' }]
});

const postFacebook = node({
  type: 'n8n-nodes-base.facebookGraphApi',
  version: 1,
  config: {
    name: 'Post to Facebook Page',
    position: [1800, 1260],
    onError: 'continueRegularOutput',
    parameters: {
      authType: 'accessToken',
      hostUrl: 'graph.facebook.com',
      httpRequestMethod: 'POST',
      graphApiVersion: 'v21.0',
      node: placeholder('Your Facebook Page ID'),
      edge: 'feed',
      options: {
        queryParameters: {
          parameter: [{ name: 'message', value: expr('{{ $json.text }}') }]
        }
      }
    },
    credentials: { facebookGraphApi: newCredential('Facebook Graph API') }
  },
  output: [{ id: '123456789_987654321' }]
});

const postTelegram = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Post to Telegram',
    position: [1800, 1680],
    onError: 'continueRegularOutput',
    parameters: {
      resource: 'message',
      operation: 'sendMessage',
      chatId: placeholder('Your Telegram channel or chat ID'),
      text: expr('{{ $json.text }}'),
      additionalFields: { appendAttribution: false, disable_web_page_preview: false }
    },
    credentials: { telegramApi: newCredential('Telegram Bot') }
  },
  output: [{ ok: true, result: { message_id: 4242, text: 'Shipping a new release today.' } }]
});

const postDiscord = node({
  type: 'n8n-nodes-base.discord',
  version: 2,
  config: {
    name: 'Post to Discord',
    position: [1800, 2100],
    onError: 'continueRegularOutput',
    parameters: {
      authentication: 'botToken',
      sendTo: 'channel',
      guildId: { __rl: true, mode: 'list', value: '' },
      channelId: { __rl: true, mode: 'list', value: '' },
      content: expr('{{ $json.text }}')
    },
    credentials: { discordBotApi: newCredential('Discord Bot') }
  },
  output: [{ id: '1180000000000000000', channel_id: '1170000000000000000', content: 'Shipping a new release today.' }]
});

const postReddit = node({
  type: 'n8n-nodes-base.reddit',
  version: 1,
  config: {
    name: 'Post to Reddit',
    position: [1800, 2520],
    onError: 'continueRegularOutput',
    parameters: {
      resource: 'post',
      operation: 'create',
      subreddit: expr('{{ $json.reddit_subreddit }}'),
      kind: 'self',
      title: expr('{{ $json.reddit_title }}'),
      text: expr('{{ $json.text }}')
    },
    credentials: { redditOAuth2Api: newCredential('Reddit') }
  },
  output: [{ id: 'abc123', name: 't3_abc123', url: 'https://www.reddit.com/r/n8n/comments/abc123/' }]
});

const stampX = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: { name: 'Record X Result', position: [2160, 420], parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: `const PLATFORM = 'x';

const s = $('Normalize Submission').first().json;
const targets = $('Expand to Targets').all().map(function (i) { return i.json; });
const t = targets.find(function (x) { return x.platform === PLATFORM; }) || {};
const r = $input.first() ? $input.first().json : {};

const rawError = r && r.error ? r.error : null;
const err = rawError ? (rawError.message || String(rawError)) : '';
const remote = err ? '' : String(
  r.id || r.urn || r.name || (r.result && r.result.message_id) || ''
);

return [{
  json: {
    post_id: s.post_id,
    posted_at: new Date().toISOString(),
    platform: PLATFORM,
    status: err ? 'failed' : 'sent',
    text_sent: t.text || '',
    char_count: t.char_count || 0,
    char_limit: t.char_limit || 0,
    truncated: t.truncated === true,
    link: s.link || '',
    remote_ref: remote,
    error: err
  }
}];` } },
  output: [{ post_id: 'P20260826-104500', posted_at: '2026-08-26T10:45:02.000Z', platform: 'x', status: 'sent', text_sent: 'Shipping a new release today.', char_count: 57, char_limit: 280, truncated: false, link: '', remote_ref: '1799999999999999999', error: '' }]
});

const stampLinkedIn = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: { name: 'Record LinkedIn Result', position: [2160, 840], parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: `const PLATFORM = 'linkedin';

const s = $('Normalize Submission').first().json;
const targets = $('Expand to Targets').all().map(function (i) { return i.json; });
const t = targets.find(function (x) { return x.platform === PLATFORM; }) || {};
const r = $input.first() ? $input.first().json : {};

const rawError = r && r.error ? r.error : null;
const err = rawError ? (rawError.message || String(rawError)) : '';
const remote = err ? '' : String(
  r.id || r.urn || r.name || (r.result && r.result.message_id) || ''
);

return [{
  json: {
    post_id: s.post_id,
    posted_at: new Date().toISOString(),
    platform: PLATFORM,
    status: err ? 'failed' : 'sent',
    text_sent: t.text || '',
    char_count: t.char_count || 0,
    char_limit: t.char_limit || 0,
    truncated: t.truncated === true,
    link: s.link || '',
    remote_ref: remote,
    error: err
  }
}];` } },
  output: [{ post_id: 'P20260826-104500', posted_at: '2026-08-26T10:45:02.000Z', platform: 'linkedin', status: 'sent', text_sent: 'Shipping a new release today.', char_count: 57, char_limit: 3000, truncated: false, link: '', remote_ref: 'urn:li:share:7000000000000000000', error: '' }]
});

const stampFacebook = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: { name: 'Record Facebook Result', position: [2160, 1260], parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: `const PLATFORM = 'facebook';

const s = $('Normalize Submission').first().json;
const targets = $('Expand to Targets').all().map(function (i) { return i.json; });
const t = targets.find(function (x) { return x.platform === PLATFORM; }) || {};
const r = $input.first() ? $input.first().json : {};

const rawError = r && r.error ? r.error : null;
const err = rawError ? (rawError.message || String(rawError)) : '';
const remote = err ? '' : String(
  r.id || r.urn || r.name || (r.result && r.result.message_id) || ''
);

return [{
  json: {
    post_id: s.post_id,
    posted_at: new Date().toISOString(),
    platform: PLATFORM,
    status: err ? 'failed' : 'sent',
    text_sent: t.text || '',
    char_count: t.char_count || 0,
    char_limit: t.char_limit || 0,
    truncated: t.truncated === true,
    link: s.link || '',
    remote_ref: remote,
    error: err
  }
}];` } },
  output: [{ post_id: 'P20260826-104500', posted_at: '2026-08-26T10:45:02.000Z', platform: 'facebook', status: 'sent', text_sent: 'Shipping a new release today.', char_count: 57, char_limit: 63206, truncated: false, link: '', remote_ref: '123456789_987654321', error: '' }]
});

const stampTelegram = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: { name: 'Record Telegram Result', position: [2160, 1680], parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: `const PLATFORM = 'telegram';

const s = $('Normalize Submission').first().json;
const targets = $('Expand to Targets').all().map(function (i) { return i.json; });
const t = targets.find(function (x) { return x.platform === PLATFORM; }) || {};
const r = $input.first() ? $input.first().json : {};

const rawError = r && r.error ? r.error : null;
const err = rawError ? (rawError.message || String(rawError)) : '';
const remote = err ? '' : String(
  r.id || r.urn || r.name || (r.result && r.result.message_id) || ''
);

return [{
  json: {
    post_id: s.post_id,
    posted_at: new Date().toISOString(),
    platform: PLATFORM,
    status: err ? 'failed' : 'sent',
    text_sent: t.text || '',
    char_count: t.char_count || 0,
    char_limit: t.char_limit || 0,
    truncated: t.truncated === true,
    link: s.link || '',
    remote_ref: remote,
    error: err
  }
}];` } },
  output: [{ post_id: 'P20260826-104500', posted_at: '2026-08-26T10:45:02.000Z', platform: 'telegram', status: 'sent', text_sent: 'Shipping a new release today.', char_count: 57, char_limit: 4096, truncated: false, link: '', remote_ref: '4242', error: '' }]
});

const stampDiscord = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: { name: 'Record Discord Result', position: [2160, 2100], parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: `const PLATFORM = 'discord';

const s = $('Normalize Submission').first().json;
const targets = $('Expand to Targets').all().map(function (i) { return i.json; });
const t = targets.find(function (x) { return x.platform === PLATFORM; }) || {};
const r = $input.first() ? $input.first().json : {};

const rawError = r && r.error ? r.error : null;
const err = rawError ? (rawError.message || String(rawError)) : '';
const remote = err ? '' : String(
  r.id || r.urn || r.name || (r.result && r.result.message_id) || ''
);

return [{
  json: {
    post_id: s.post_id,
    posted_at: new Date().toISOString(),
    platform: PLATFORM,
    status: err ? 'failed' : 'sent',
    text_sent: t.text || '',
    char_count: t.char_count || 0,
    char_limit: t.char_limit || 0,
    truncated: t.truncated === true,
    link: s.link || '',
    remote_ref: remote,
    error: err
  }
}];` } },
  output: [{ post_id: 'P20260826-104500', posted_at: '2026-08-26T10:45:02.000Z', platform: 'discord', status: 'sent', text_sent: 'Shipping a new release today.', char_count: 57, char_limit: 2000, truncated: false, link: '', remote_ref: '1180000000000000000', error: '' }]
});

const stampReddit = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: { name: 'Record Reddit Result', position: [2160, 2520], parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: `const PLATFORM = 'reddit';

const s = $('Normalize Submission').first().json;
const targets = $('Expand to Targets').all().map(function (i) { return i.json; });
const t = targets.find(function (x) { return x.platform === PLATFORM; }) || {};
const r = $input.first() ? $input.first().json : {};

const rawError = r && r.error ? r.error : null;
const err = rawError ? (rawError.message || String(rawError)) : '';
const remote = err ? '' : String(
  r.id || r.urn || r.name || (r.result && r.result.message_id) || ''
);

return [{
  json: {
    post_id: s.post_id,
    posted_at: new Date().toISOString(),
    platform: PLATFORM,
    status: err ? 'failed' : 'sent',
    text_sent: t.text || '',
    char_count: t.char_count || 0,
    char_limit: t.char_limit || 0,
    truncated: t.truncated === true,
    link: s.link || '',
    remote_ref: remote,
    error: err
  }
}];` } },
  output: [{ post_id: 'P20260826-104500', posted_at: '2026-08-26T10:45:02.000Z', platform: 'reddit', status: 'sent', text_sent: 'Shipping a new release today.', char_count: 57, char_limit: 40000, truncated: false, link: '', remote_ref: 't3_abc123', error: '' }]
});

const collectResults = merge({
  version: 3.2,
  config: {
    name: 'Collect Delivery Results',
    position: [2520, 1260],
    parameters: { mode: 'append', numberInputs: 6 }
  }
});

const logDelivery = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Log Delivery',
    position: [2880, 1260],
    parameters: {
      resource: 'row',
      operation: 'insert',
      dataTableId: { __rl: true, mode: 'list', value: 'si7SiekpdNY6mYOr', cachedResultName: 'social_post_log' },
      columns: { mappingMode: 'autoMapInputData', value: null, matchingColumns: [] }
    }
  },
  output: [{ id: 1, createdAt: '2026-08-26T10:45:03.000Z', updatedAt: '2026-08-26T10:45:03.000Z' }]
});

const done = node({
  type: 'n8n-nodes-base.form',
  version: 2.5,
  config: {
    name: 'Show Result',
    position: [3240, 1260],
    parameters: {
      operation: 'completion',
      respondWith: 'text',
      completionTitle: 'Dispatched',
      completionMessage: expr('Sent to {{ $(\'Expand to Targets\').all().length }} channel(s). Check the social_post_log table for the per-platform outcome, including anything that failed.')
    }
  },
  output: [{}]
});

const readme = sticky("# Social Post Distributor\n## Write once. Publish to six platforms. Log every outcome.\n\n**What it does:** you fill in one short form — the post text, an optional link, and which channels you want. n8n then sends a correctly-sized copy to each platform you ticked, and records exactly what happened on every one.\n\n| The problem | How this handles it |\n| --- | --- |\n| Platforms have wildly different length limits | Each copy is trimmed to that platform's own ceiling, and flagged when it was trimmed |\n| One platform failing could kill the whole run | Every publish node continues on error — the others still go out |\n| \"Did it actually post?\" | Every attempt writes a row: sent or failed, with the platform's own reference or the error text |\n| Losing the post if everything fails | The raw submission is saved **before** anything is sent |\n\n### Two honest limits\n**No Instagram or Mastodon node exists in n8n.** Instagram posting requires the Facebook Graph API with a Business account linked to a Page, and a different two-step flow — it is not a drop-in seventh branch.\n**Nothing runs until you connect credentials** in Settings → Credentials. Connect only the platforms you actually want; the rest never execute.\n\n### How to read this canvas\nLeft to right, then top to bottom through the six branches. **Every node has a numbered card beneath it** — what it takes in, what it does, why it is there, and what it hands on.", [], {
  name: "README",
  position: [0, -620],
  width: 1700,
  height: 500,
  color: 7
});

const card01 = sticky("### 1 · Compose Post\n`n8n Form Trigger`\n\n**Does:** shows a public web form and starts a run when someone submits it.\n\n**Takes in:** nothing — a person fills it in.\n\n**Purpose:** one place to write the post, needing no n8n knowledge.\n\n**Hands on:** `Post text` · `Link` · `Platforms` · `Subreddit` · `Reddit title`", [], {
  name: "Card 01 Compose Post",
  position: [0, 140],
  width: 300,
  height: 240,
  color: 7
});

const card02 = sticky("### 2 · Normalize Submission\n`Edit Fields (Set)`\n\n**Does:** turns the form's human labels into clean field names and stamps an ID.\n\n**Takes in:** the raw form submission.\n\n**Purpose:** you can reword the form later without breaking everything downstream.\n\n**Hands on:** `post_id` `submitted_at` `post_text` `link` `platforms` (lowercase CSV) + the Reddit fields", [], {
  name: "Card 02 Normalize",
  position: [360, 140],
  width: 300,
  height: 260,
  color: 4
});

const card03 = sticky("### 3 · Store Submission\n`Data table` · insert\n\n**Does:** saves the submission to **social_post_submissions** before a single post is sent.\n\n**Takes in:** the normalized fields.\n\n**Purpose:** if every platform fails, the post itself is still never lost.\n\n**Hands on:** the stored row + `id`.\n\n⚠️ Its output is the row, **not** your data — which is why the next node reads back from step 2.", [], {
  name: "Card 03 Store Submission",
  position: [720, 140],
  width: 300,
  height: 280,
  color: 4
});

const card04 = sticky("### 4 · Expand to Targets\n`Code` · once for all items\n\n**Does:** turns one submission into one item per chosen platform, trimming each copy to that platform's limit and keeping the link on the end.\n\n**Takes in:** reads back from `Normalize Submission`.\n\n**Purpose:** a 400-character post is fine on LinkedIn and illegal on X.\n\n**Hands on:** N items — `platform` `text` `char_count` `char_limit` `truncated`\n\nX 280 · Discord 2k · LinkedIn 3k\nTelegram 4k · Reddit 40k · Facebook 63k", [], {
  name: "Card 04 Expand to Targets",
  position: [1080, 140],
  width: 300,
  height: 320,
  color: 5
});

const card05 = sticky("### 5 · Route by Platform\n`Switch` · 6 outputs\n\n**Does:** sends each item down the branch built for its own platform.\n\n**Takes in:** one item per chosen platform.\n\n**Purpose:** every service needs a different node and different fields.\n\n**Hands on:** the same item, on exactly one of six outputs. Platforms you did not tick produce nothing at all.", [], {
  name: "Card 05 Route by Platform",
  position: [1440, 140],
  width: 300,
  height: 260,
  color: 5
});

const card06 = sticky("### 6 · Post to X\n`X (Twitter)` · tweet → create\n\n**Does:** publishes the trimmed copy as a tweet.\n\n**Takes in:** the item routed to this branch.\n\n**Needs:** a `twitterOAuth2Api` credential.\n\n**Hands on:** the API response — tweet `id`.\n\n🔁 `continueRegularOutput` — failing here cannot stop the other branches.", [], {
  name: "Card 06 Post to X",
  position: [1800, 560],
  width: 300,
  height: 250,
  color: 2
});

const card07 = sticky("### 7 · Record X Result\n`Code` · once for all items\n\n**Does:** builds the log row for this branch.\n\n**Takes in:** the X response, plus a look back at steps 2 and 4 for the text and limits.\n\n**Purpose:** platform is hardcoded per branch, so log attribution is never a guess.\n\n**Hands on:** 1 row — `status` · `text_sent` · `truncated` · `remote_ref` from tweet `id` · `error`", [], {
  name: "Card 07 Record X",
  position: [2160, 560],
  width: 300,
  height: 250,
  color: 3
});

const card08 = sticky("### 8 · Post to LinkedIn\n`LinkedIn` · post → create\n\n**Does:** publishes the copy as a public post from a person.\n\n**Takes in:** the item routed to this branch.\n\n**Needs:** a `linkedInOAuth2Api` credential **and your person URN** — pick it from the list once connected.\n\n**Hands on:** the share `urn`.", [], {
  name: "Card 08 Post to LinkedIn",
  position: [1800, 980],
  width: 300,
  height: 250,
  color: 2
});

const card09 = sticky("### 9 · Record LinkedIn Result\n`Code` · once for all items\n\n**Does:** builds the log row for this branch.\n\n**Takes in:** the LinkedIn response, plus the text and limits from steps 2 and 4.\n\n**Purpose:** same shape as every other branch, so one storage node can serve them all.\n\n**Hands on:** 1 row — `remote_ref` from the share `urn`.", [], {
  name: "Card 09 Record LinkedIn",
  position: [2160, 980],
  width: 300,
  height: 250,
  color: 3
});

const card10 = sticky("### 10 · Post to Facebook Page\n`Facebook Graph API`\n\n**Does:** POSTs the copy to your Page's `/feed` edge.\n\n**Takes in:** the item routed to this branch.\n\n**Needs:** a `facebookGraphApi` credential **and your Page ID**.\n\n**Hands on:** the new post `id`.\n\nℹ️ There is no dedicated Facebook post node — the Graph API node is the supported route.", [], {
  name: "Card 10 Post to Facebook",
  position: [1800, 1400],
  width: 300,
  height: 260,
  color: 2
});

const card11 = sticky("### 11 · Record Facebook Result\n`Code` · once for all items\n\n**Does:** builds the log row for this branch.\n\n**Takes in:** the Graph API response, plus the text and limits from steps 2 and 4.\n\n**Purpose:** turns a raw API reply into the same 11-column row every branch produces.\n\n**Hands on:** 1 row — `remote_ref` from the post `id`.", [], {
  name: "Card 11 Record Facebook",
  position: [2160, 1400],
  width: 300,
  height: 250,
  color: 3
});

const card12 = sticky("### 12 · Post to Telegram\n`Telegram` · message → sendMessage\n\n**Does:** sends the copy to a channel, group or chat.\n\n**Takes in:** the item routed to this branch.\n\n**Needs:** a `telegramApi` bot credential **and the chat ID**.\n\n**Hands on:** `result.message_id`.\n\n✅ n8n's \"sent automatically\" footer is switched off.", [], {
  name: "Card 12 Post to Telegram",
  position: [1800, 1820],
  width: 300,
  height: 250,
  color: 2
});

const card13 = sticky("### 13 · Record Telegram Result\n`Code` · once for all items\n\n**Does:** builds the log row for this branch.\n\n**Takes in:** the Telegram response, plus the text and limits from steps 2 and 4.\n\n**Purpose:** keeps Telegram's nested reply shape out of the log table.\n\n**Hands on:** 1 row — `remote_ref` from `result.message_id`.", [], {
  name: "Card 13 Record Telegram",
  position: [2160, 1820],
  width: 300,
  height: 250,
  color: 3
});

const card14 = sticky("### 14 · Post to Discord\n`Discord` · message → send\n\n**Does:** posts the copy into a channel as a bot.\n\n**Takes in:** the item routed to this branch.\n\n**Needs:** a `discordBotApi` credential, then **pick the server and channel** — both pickers are empty until the credential exists.\n\n**Hands on:** the message `id`.", [], {
  name: "Card 14 Post to Discord",
  position: [1800, 2240],
  width: 300,
  height: 250,
  color: 2
});

const card15 = sticky("### 15 · Record Discord Result\n`Code` · once for all items\n\n**Does:** builds the log row for this branch.\n\n**Takes in:** the Discord response, plus the text and limits from steps 2 and 4.\n\n**Purpose:** one row shape regardless of which service replied.\n\n**Hands on:** 1 row — `remote_ref` from the message `id`.", [], {
  name: "Card 15 Record Discord",
  position: [2160, 2240],
  width: 300,
  height: 250,
  color: 3
});

const card16 = sticky("### 16 · Post to Reddit\n`Reddit` · post → create\n\n**Does:** submits a self (text) post to a subreddit.\n\n**Takes in:** the item routed to this branch.\n\n**Needs:** a `redditOAuth2Api` credential.\n\n⚠️ **Unlike the others, this one needs per-post input:** the `Subreddit` and `Reddit title` fields on the form. Leave them blank and Reddit will reject the post.\n\n**Hands on:** `name` (e.g. `t3_abc123`).", [], {
  name: "Card 16 Post to Reddit",
  position: [1800, 2660],
  width: 300,
  height: 260,
  color: 2
});

const card17 = sticky("### 17 · Record Reddit Result\n`Code` · once for all items\n\n**Does:** builds the log row for this branch.\n\n**Takes in:** the Reddit response, plus the text and limits from steps 2 and 4.\n\n**Purpose:** a missing title or subreddit shows up here as a real logged failure, not silence.\n\n**Hands on:** 1 row — `remote_ref` from `name`.", [], {
  name: "Card 17 Record Reddit",
  position: [2160, 2660],
  width: 300,
  height: 250,
  color: 3
});

const card18 = sticky("### 18 · Collect Delivery Results\n`Merge` · append, 6 inputs\n\n**Does:** funnels the six branches back into a single stream.\n\n**Takes in:** only the branches that actually ran — the rest arrive empty.\n\n**Purpose:** lets one storage node serve every platform instead of six near-copies.\n\n**Hands on:** one row per platform attempted.", [], {
  name: "Card 18 Collect Results",
  position: [2520, 1400],
  width: 300,
  height: 250,
  color: 6
});

const card19 = sticky("### 19 · Log Delivery\n`Data table` · insert\n\n**Does:** appends every row to **social_post_log**.\n\n**Takes in:** the merged rows, auto-mapped by column name.\n\n**Purpose:** the record of what actually went out — your answer to \"did it post?\"\n\n**Hands on:** the stored rows + `id`.\n\n✅ Built into n8n. No credentials needed for this step.", [], {
  name: "Card 19 Log Delivery",
  position: [2880, 1400],
  width: 300,
  height: 270,
  color: 6
});

const card20 = sticky("### 20 · Show Result\n`n8n Form` · completion\n\n**Does:** shows the confirmation page to whoever submitted the form.\n\n**Takes in:** the stored log rows.\n\n**Purpose:** closes the loop for the person, instead of leaving a form spinning.\n\n**Hands on:** nothing — this is the end of the run.\n\nℹ️ The execution sits in `waiting` until a browser collects this page. Normal for n8n forms.", [], {
  name: "Card 20 Show Result",
  position: [3240, 1400],
  width: 300,
  height: 270,
  color: 6
});

export default workflow('social-post-distributor', 'Social Post Distributor')
  .add(composeForm)
  .to(normalize)
  .to(storeSubmission)
  .to(expandTargets)
  .to(routePlatform
    .onCase(0, postX.to(stampX.to(collectResults.input(0))))
    .onCase(1, postLinkedIn.to(stampLinkedIn.to(collectResults.input(1))))
    .onCase(2, postFacebook.to(stampFacebook.to(collectResults.input(2))))
    .onCase(3, postTelegram.to(stampTelegram.to(collectResults.input(3))))
    .onCase(4, postDiscord.to(stampDiscord.to(collectResults.input(4))))
    .onCase(5, postReddit.to(stampReddit.to(collectResults.input(5)))))
  .add(collectResults)
  .to(logDelivery)
  .to(done)
  .add(readme)
  .add(card01)
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
  .add(card13)
  .add(card14)
  .add(card15)
  .add(card16)
  .add(card17)
  .add(card18)
  .add(card19)
  .add(card20);
