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
    position: [300, 0],
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
    position: [600, 0],
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
    position: [900, 0],
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
    position: [1200, 0],
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
    position: [1520, -520],
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
    position: [1520, -320],
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
    position: [1520, -120],
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
    position: [1520, 80],
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
    position: [1520, 280],
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
    position: [1520, 480],
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
  config: { name: 'Record X Result', position: [1840, -520], parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: `const PLATFORM = 'x';

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
  config: { name: 'Record LinkedIn Result', position: [1840, -320], parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: `const PLATFORM = 'linkedin';

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
  config: { name: 'Record Facebook Result', position: [1840, -120], parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: `const PLATFORM = 'facebook';

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
  config: { name: 'Record Telegram Result', position: [1840, 80], parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: `const PLATFORM = 'telegram';

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
  config: { name: 'Record Discord Result', position: [1840, 280], parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: `const PLATFORM = 'discord';

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
  config: { name: 'Record Reddit Result', position: [1840, 480], parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: `const PLATFORM = 'reddit';

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
    position: [2180, -20],
    parameters: { mode: 'append', numberInputs: 6 }
  }
});

const logDelivery = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Log Delivery',
    position: [2480, -20],
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
    position: [2780, -20],
    parameters: {
      operation: 'completion',
      respondWith: 'text',
      completionTitle: 'Dispatched',
      completionMessage: expr('Sent to {{ $(\'Expand to Targets\').all().length }} channel(s). Check the social_post_log table for the per-platform outcome, including anything that failed.')
    }
  },
  output: [{}]
});

const noteIntro = sticky(
  '## Social Post Distributor\n\nWrite a post once, choose the channels, and let n8n fan it out. Every attempt is logged per platform — including failures — so you always know what actually went live.\n\n**Nothing here runs until you connect credentials.** Each platform node has an empty credential slot waiting in the n8n UI. Connect only the platforms you actually want; unselected ones never execute.\n\n**Not available as nodes:** Instagram and Mastodon. Instagram posting only works through the Facebook Graph API with a Business account linked to a Page.',
  [composeForm, normalize, storeSubmission],
  { color: 7 }
);

const noteExpand = sticky(
  '## Fan out, one item per channel\n\n`Expand to Targets` turns a single submission into one item per selected platform, and trims the text to that platform\'s real character ceiling:\n\n**X** 280 · **Discord** 2,000 · **LinkedIn** 3,000 · **Telegram** 4,096 · **Reddit** 40,000 · **Facebook** 63,206\n\nWhen a trim happens the item carries `truncated: true`, so the log tells you honestly that the audience saw a shortened version.',
  [expandTargets, routePlatform],
  { color: 4 }
);

const notePublish = sticky(
  '## Publish\n\nEvery platform node is set to `continueRegularOutput`, so **one platform failing never blocks the others**. A failed post produces an item carrying an error instead of stopping the run.\n\nFields still needing your input once credentials exist: the LinkedIn person URN, the Facebook Page ID, the Telegram chat ID, and the Discord server + channel pickers.',
  [postX, postReddit],
  { color: 3 }
);

const noteLog = sticky(
  '## Record every outcome\n\nEach branch records its own result, so the log never guesses which platform an API response came from.\n\nRows land in **social_post_log** with `status` (sent / failed), the exact `text_sent`, `char_count` against `char_limit`, whether it was `truncated`, the platform\'s own `remote_ref`, and the `error` when there was one. Raw submissions are kept separately in **social_post_submissions**.',
  [collectResults, logDelivery, done],
  { color: 6 }
);

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
  .add(noteIntro)
  .add(noteExpand)
  .add(notePublish)
  .add(noteLog);
