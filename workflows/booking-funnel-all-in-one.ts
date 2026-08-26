import { workflow, node, trigger, sticky, ifElse, switchCase, expr } from '@n8n/workflow-sdk';

const errTrig = trigger({
  type: 'n8n-nodes-base.errorTrigger', version: 1,
  config: { name: 'A1 Workflow Failed', position: [0, 0] },
  output: [{ execution: { id: '1', error: { message: 'boom' }, lastNodeExecuted: 'X' }, workflow: { id: 'w', name: 'Booking Funnel' } }]
});
const errBuild = node({
  type: 'n8n-nodes-base.code', version: 2,
  config: { name: 'A2 Build Ops Event', position: [360, 0], parameters: { mode: 'runOnceForAllItems', language: 'javaScript',
    jsCode: `const e = $input.first().json || {};
const ex = e.execution || {}; const wf = e.workflow || {}; const err = ex.error || e.error || {};
function clip(v, n) { const s = v == null ? '' : String(v); return s.length > n ? s.slice(0, n) : s; }
return [{ json: {
  event_id: 'E' + Date.now().toString(36),
  workflow_name: clip(wf.name || 'unknown', 200),
  workflow_id: clip(wf.id || '', 60),
  node_name: clip(ex.lastNodeExecuted || 'unknown', 200),
  level: 'error',
  message: clip(err.message || 'Unknown failure', 900),
  execution_id: clip(ex.id || '', 60),
  execution_url: clip(ex.url || '', 400),
  context: clip(JSON.stringify({ errorName: err.name || '', mode: ex.mode || '' }), 1500),
  created_at: new Date().toISOString()
}}];` } },
  output: [{ event_id: 'E1', workflow_name: 'Booking Funnel', level: 'error', message: 'boom' }]
});
const errWrite = node({
  type: 'n8n-nodes-base.dataTable', version: 1.1,
  config: { name: 'A3 Write ops_events', position: [720, 0], parameters: { resource: 'row', operation: 'insert',
    dataTableId: { __rl: true, mode: 'list', value: 'RnlzXRfhSe8rRWiq', cachedResultName: 'ops_events' },
    columns: { mappingMode: 'autoMapInputData', value: null, matchingColumns: [] } } },
  output: [{ id: 1 }]
});

const clickIn = trigger({
  type: 'n8n-nodes-base.webhook', version: 2.1,
  config: { name: 'B1 Inbound Click', position: [0, 700], parameters: { httpMethod: 'GET', path: 'go', responseMode: 'responseNode' } },
  output: [{ query: { p: 'post_001', c: 'telegram' }, headers: { 'user-agent': 'Mozilla/5.0' } }]
});
const chanCfg = node({
  type: 'n8n-nodes-base.set', version: 3.5,
  config: { name: 'B2 Channel Config', position: [360, 700], parameters: { mode: 'manual', includeOtherFields: false,
    assignments: { assignments: [
      { id: 'q1', name: 'telegram_bot', value: 'your_bot_username', type: 'string' },
      { id: 'q2', name: 'messenger_page', value: '', type: 'string' },
      { id: 'q3', name: 'whatsapp_number', value: '', type: 'string' },
      { id: 'q4', name: 'instagram_user', value: '', type: 'string' },
      { id: 'q5', name: 'whatsapp_prefill', value: 'Hi! I saw your post.', type: 'string' }
    ] } } },
  output: [{ telegram_bot: 'your_bot_username' }]
});
const clickResolve = node({
  type: 'n8n-nodes-base.code', version: 2,
  config: { name: 'B3 Resolve Redirect', position: [720, 700], parameters: { mode: 'runOnceForAllItems', language: 'javaScript',
    jsCode: `const req = $('B1 Inbound Click').first().json || {};
const q = req.query || {}; const h = req.headers || {}; const cfg = $input.first().json || {};
const postId = String(q.p || '').trim().slice(0, 80);
const channel = String(q.c || '').trim().toLowerCase().slice(0, 20);
const AB = 'abcdefghijklmnopqrstuvwxyz0123456789';
let token = '';
for (let i = 0; i < 22; i++) { token += AB.charAt(Math.floor(Math.random() * AB.length)); }
const ua = String(h['user-agent'] || '');
const isBot = /bot|crawl|spider|preview|facebookexternalhit|slurp|headless/i.test(ua);
const targets = {
  telegram: cfg.telegram_bot ? 'https://t.me/' + cfg.telegram_bot + '?start=' + token : '',
  messenger: cfg.messenger_page ? 'https://m.me/' + cfg.messenger_page + '?ref=' + token : '',
  whatsapp: cfg.whatsapp_number ? 'https://wa.me/' + cfg.whatsapp_number + '?text=' + encodeURIComponent(String(cfg.whatsapp_prefill || 'Hi!') + ' [ref:' + token + ']') : '',
  instagram: cfg.instagram_user ? 'https://ig.me/m/' + cfg.instagram_user : ''
};
const ATTR = { telegram: 'exact', messenger: 'exact', whatsapp: 'prefill', instagram: 'inferred' };
const target = targets[channel] || '';
function hashOf(s) { let v = 0; for (let i = 0; i < s.length; i++) { v = ((v << 5) - v + s.charCodeAt(i)) | 0; } return String(v >>> 0); }
const ip = String(h['x-forwarded-for'] || '').split(',')[0].trim();
return [{ json: {
  ok: target !== '', click_id: 'C' + Date.now().toString(36) + token.slice(0, 6),
  post_id: postId || 'unknown', platform: channel || 'unknown', clicked_at: new Date().toISOString(),
  redirect_target: target, attribution_token: token, attribution: ATTR[channel] || 'unknown',
  user_agent: ua.slice(0, 300), referer: String(h.referer || '').slice(0, 300),
  ip_hash: ip ? hashOf(ip) : '', is_bot: isBot
}}];` } },
  output: [{ ok: true, click_id: 'C1', post_id: 'post_001', platform: 'telegram', redirect_target: 'https://t.me/x?start=abc', attribution_token: 'abc', attribution: 'exact', is_bot: false }]
});
const clickOk = ifElse({
  version: 2.3,
  config: { name: 'B4 Resolvable?', position: [1080, 700], parameters: {
    conditions: { options: { caseSensitive: false, leftValue: '', typeValidation: 'loose' },
      conditions: [{ leftValue: expr('{{ $json.ok }}'), operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' },
    looseTypeValidation: true } }
});
const clickRow = node({
  type: 'n8n-nodes-base.set', version: 3.5,
  config: { name: 'B5 Shape Click Row', position: [1440, 560], parameters: { mode: 'manual', includeOtherFields: false,
    assignments: { assignments: [
      { id: 'r1', name: 'click_id', value: expr('{{ $json.click_id }}'), type: 'string' },
      { id: 'r2', name: 'post_id', value: expr('{{ $json.post_id }}'), type: 'string' },
      { id: 'r3', name: 'platform', value: expr('{{ $json.platform }}'), type: 'string' },
      { id: 'r4', name: 'clicked_at', value: expr('{{ $json.clicked_at }}'), type: 'string' },
      { id: 'r5', name: 'redirect_target', value: expr('{{ $json.redirect_target }}'), type: 'string' },
      { id: 'r6', name: 'attribution_token', value: expr('{{ $json.attribution_token }}'), type: 'string' },
      { id: 'r7', name: 'attribution', value: expr('{{ $json.attribution }}'), type: 'string' },
      { id: 'r8', name: 'user_agent', value: expr('{{ $json.user_agent }}'), type: 'string' },
      { id: 'r9', name: 'referer', value: expr('{{ $json.referer }}'), type: 'string' },
      { id: 'r10', name: 'ip_hash', value: expr('{{ $json.ip_hash }}'), type: 'string' },
      { id: 'r11', name: 'is_bot', value: expr('{{ $json.is_bot }}'), type: 'boolean' }
    ] } } },
  output: [{ click_id: 'C1', post_id: 'post_001' }]
});
const clickLog = node({
  type: 'n8n-nodes-base.dataTable', version: 1.1,
  config: { name: 'B6 Log Click', position: [1800, 560], onError: 'continueRegularOutput', parameters: { resource: 'row', operation: 'insert',
    dataTableId: { __rl: true, mode: 'list', value: 'PGHVw6wnYmJ2umyp', cachedResultName: 'click_events' },
    columns: { mappingMode: 'autoMapInputData', value: null, matchingColumns: [] } } },
  output: [{ id: 1 }]
});
const clickGo = node({
  type: 'n8n-nodes-base.respondToWebhook', version: 1.5,
  config: { name: 'B7 Redirect to Chat', position: [2160, 560], parameters: { respondWith: 'redirect',
    redirectURL: expr("{{ $('B3 Resolve Redirect').first().json.redirect_target }}"), options: { responseCode: 302 } } },
  output: [{}]
});
const clickBad = node({
  type: 'n8n-nodes-base.respondToWebhook', version: 1.5,
  config: { name: 'B8 Unknown Channel', position: [1440, 840], parameters: { respondWith: 'text',
    responseBody: 'This link is not configured. Check the ?c= parameter and B2 Channel Config.', options: { responseCode: 404 } } },
  output: [{}]
});

const chatIn = trigger({
  type: 'n8n-nodes-base.webhook', version: 2.1,
  config: { name: 'C1 Inbound Message', position: [0, 1400], parameters: { httpMethod: 'POST', path: 'chat', responseMode: 'responseNode' } },
  output: [{ body: { platform: 'telegram', user_id: '555', name: 'Ana', text: '/start abc' } }]
});
const botCfg = node({
  type: 'n8n-nodes-base.set', version: 3.5,
  config: { name: 'C2 Bot Config', position: [360, 1400], parameters: { mode: 'manual', includeOtherFields: false,
    assignments: { assignments: [
      { id: 'w1', name: 'welcome', value: 'Hi {name}! Thanks for coming over from our post. Ask me about pricing, hours, location or booking.', type: 'string' },
      { id: 'w2', name: 'fallback', value: 'I am not sure about that yet. I can help with pricing, hours, location, booking, rescheduling and session length.', type: 'string' },
      { id: 'w3', name: 'booking_url', value: 'https://gipre.app.n8n.cloud/form/book', type: 'string' },
      { id: 'w4', name: 'min_score', value: 0.3, type: 'number' }
    ] } } },
  output: [{ welcome: 'Hi {name}!', fallback: 'Not sure.', min_score: 0.3 }]
});
const chatNorm = node({
  type: 'n8n-nodes-base.code', version: 2,
  config: { name: 'C3 Normalize Inbound', position: [720, 1400], parameters: { mode: 'runOnceForAllItems', language: 'javaScript',
    jsCode: `const req = $('C1 Inbound Message').first().json || {}; const b = req.body || req;
const platform = String(b.platform || 'telegram').toLowerCase().slice(0, 20);
const userId = String(b.user_id || '').trim().slice(0, 80);
const name = String(b.name || 'there').trim().slice(0, 120);
const raw = String(b.text || '').trim().slice(0, 2000);
let token = String(b.ref || b.payload || '').trim(); let text = raw;
const sm = raw.match(/^\\/start(?:\\s+([A-Za-z0-9_-]{6,64}))?$/);
if (sm) { token = sm[1] || token; text = ''; }
const ir = raw.match(/\\[ref:([A-Za-z0-9_-]{6,64})\\]/);
if (ir) { token = ir[1]; text = raw.replace(ir[0], '').trim(); }
return [{ json: { platform: platform, user_id: userId, display_name: name, text: text, raw_text: raw, token: token.slice(0, 64), received_at: new Date().toISOString() } }];` } },
  output: [{ platform: 'telegram', user_id: '555', display_name: 'Ana', text: '', raw_text: '/start abc', token: 'abc' }]
});
const chatClick = node({
  type: 'n8n-nodes-base.dataTable', version: 1.1,
  config: { name: 'C4 Lookup Click by Token', position: [1080, 1400], alwaysOutputData: true, parameters: { resource: 'row', operation: 'get',
    dataTableId: { __rl: true, mode: 'list', value: 'PGHVw6wnYmJ2umyp', cachedResultName: 'click_events' },
    matchType: 'allConditions',
    filters: { conditions: [{ keyName: 'attribution_token', condition: 'eq', keyValue: expr('{{ $json.token || "__none__" }}') }] },
    returnAll: false, limit: 1 } },
  output: [{ post_id: 'post_001', attribution_token: 'abc', attribution: 'exact' }]
});
const chatContact = node({
  type: 'n8n-nodes-base.dataTable', version: 1.1,
  config: { name: 'C5 Lookup Contact', position: [1440, 1400], alwaysOutputData: true, parameters: { resource: 'row', operation: 'get',
    dataTableId: { __rl: true, mode: 'list', value: 'QsD7VSLQGoICmKme', cachedResultName: 'contacts' },
    matchType: 'allConditions',
    filters: { conditions: [
      { keyName: 'platform_user_id', condition: 'eq', keyValue: expr("{{ $('C3 Normalize Inbound').first().json.user_id }}") },
      { keyName: 'platform', condition: 'eq', keyValue: expr("{{ $('C3 Normalize Inbound').first().json.platform }}") }
    ] }, returnAll: false, limit: 1 } },
  output: [{}]
});
const chatSession = node({
  type: 'n8n-nodes-base.code', version: 2,
  config: { name: 'C6 Resolve Session', position: [1800, 1400], parameters: { mode: 'runOnceForAllItems', language: 'javaScript',
    jsCode: `const msg = $('C3 Normalize Inbound').first().json;
const clicks = $('C4 Lookup Click by Token').all().map(function (i) { return i.json; }).filter(function (r) { return r && r.attribution_token; });
const contacts = $('C5 Lookup Contact').all().map(function (i) { return i.json; }).filter(function (r) { return r && r.contact_id; });
const click = clicks[0] || null; const existing = contacts[0] || null;
const isNew = existing === null; const now = new Date().toISOString();
const contactId = existing ? existing.contact_id : 'CT-' + msg.platform + '-' + msg.user_id + '-' + Date.now().toString(36);
const sourcePost = existing && existing.source_post_id ? existing.source_post_id : (click ? click.post_id : '');
const attribution = existing && existing.attribution ? existing.attribution : (click ? click.attribution : 'none');
return [{ json: {
  contact_id: contactId, is_new_contact: isNew, platform: msg.platform, platform_user_id: msg.user_id,
  display_name: msg.display_name, source_post_id: sourcePost, attribution: attribution,
  first_seen: existing && existing.first_seen ? existing.first_seen : now, last_seen: now
}}];` } },
  output: [{ contact_id: 'CT-1', is_new_contact: true, platform: 'telegram', platform_user_id: 'tg-9001',
    display_name: 'Ana Reyes', source_post_id: 'post_001', attribution: 'exact',
    first_seen: '2026-01-01T00:00:00.000Z', last_seen: '2026-01-01T00:00:00.000Z' }]
});
const chatContactRow = node({
  type: 'n8n-nodes-base.set', version: 3.5,
  config: { name: 'C7 Contact Row', position: [2160, 1400], parameters: { mode: 'manual', includeOtherFields: false,
    assignments: { assignments: [
      { id: 'y1', name: 'contact_id', value: expr('{{ $json.contact_id }}'), type: 'string' },
      { id: 'y2', name: 'platform', value: expr('{{ $json.platform }}'), type: 'string' },
      { id: 'y3', name: 'platform_user_id', value: expr('{{ $json.platform_user_id }}'), type: 'string' },
      { id: 'y4', name: 'display_name', value: expr('{{ $json.display_name }}'), type: 'string' },
      { id: 'y5', name: 'email', value: '', type: 'string' },
      { id: 'y6', name: 'phone', value: '', type: 'string' },
      { id: 'y7', name: 'source_post_id', value: expr('{{ $json.source_post_id }}'), type: 'string' },
      { id: 'y8', name: 'attribution', value: expr('{{ $json.attribution }}'), type: 'string' },
      { id: 'y9', name: 'first_seen', value: expr('{{ $json.first_seen }}'), type: 'string' },
      { id: 'y10', name: 'last_seen', value: expr('{{ $json.last_seen }}'), type: 'string' }
    ] } } },
  output: [{ contact_id: 'CT-1', platform: 'telegram', platform_user_id: 'tg-9001', display_name: 'Ana Reyes',
    email: '', phone: '', source_post_id: 'post_001', attribution: 'exact',
    first_seen: '2026-01-01T00:00:00.000Z', last_seen: '2026-01-01T00:00:00.000Z' }]
});
const chatUpsert = node({
  type: 'n8n-nodes-base.dataTable', version: 1.1,
  config: { name: 'C8 Upsert Contact', position: [2520, 1400], parameters: { resource: 'row', operation: 'upsert',
    dataTableId: { __rl: true, mode: 'list', value: 'QsD7VSLQGoICmKme', cachedResultName: 'contacts' },
    matchType: 'allConditions',
    filters: { conditions: [
      { keyName: 'platform_user_id', condition: 'eq', keyValue: expr('{{ $json.platform_user_id }}') },
      { keyName: 'platform', condition: 'eq', keyValue: expr('{{ $json.platform }}') }
    ] }, columns: { mappingMode: 'autoMapInputData', value: null, matchingColumns: [] } } },
  output: [{ id: 1 }]
});
const chatFaq = node({
  type: 'n8n-nodes-base.dataTable', version: 1.1,
  config: { name: 'C9 Load FAQ', position: [2880, 1400], parameters: { resource: 'row', operation: 'get',
    dataTableId: { __rl: true, mode: 'list', value: 'BJpFxgFo6hMou1Br', cachedResultName: 'faq' }, returnAll: true } },
  output: [{ faq_id: 'F002', question: 'How much does a session cost?', answer: '4500 PHP', tags: 'price cost', active: true }]
});
const chatReply = node({
  type: 'n8n-nodes-base.code', version: 2,
  config: { name: 'C10 Compose Reply', position: [3240, 1400], parameters: { mode: 'runOnceForAllItems', language: 'javaScript',
    jsCode: `const cfg = $('C2 Bot Config').first().json;
const msg = $('C3 Normalize Inbound').first().json;
const session = $('C6 Resolve Session').first().json;
const rows = $('C9 Load FAQ').all().map(function (i) { return i.json; }).filter(function (r) { return r && r.active !== false && r.question; });
const STOP = ['the','a','an','is','are','do','does','can','i','you','we','to','of','for','in','on','at','and','or','my','your','it','how','what','when','where','me','be','with','about','have','has'];
function tok(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9\\s]/g, ' ').split(/\\s+/).filter(function (t) { return t.length > 1 && STOP.indexOf(t) === -1; }); }
const qt = tok(msg.text);
let best = null; let bestScore = 0;
rows.forEach(function (row) {
  const hay = tok(row.question + ' ' + (row.tags || ''));
  let hits = 0;
  qt.forEach(function (t) { if (hay.indexOf(t) !== -1) { hits += 1; } });
  const sc = qt.length ? hits / qt.length : 0;
  if (sc > bestScore) { bestScore = sc; best = row; }
});
const matched = best !== null && bestScore >= (Number(cfg.min_score) || 0.3) && qt.length > 0;
const wantsBooking = /book|reserve|slot|appointment|schedule/i.test(msg.text);
const parts = [];
if (session.is_new_contact) { parts.push(String(cfg.welcome || '').replace('{name}', session.display_name || 'there')); }
if (qt.length === 0) { if (!session.is_new_contact) { parts.push('Hi again! What would you like to know?'); } }
else if (matched) { parts.push(best.answer); }
else { parts.push(String(cfg.fallback || '')); }
if (wantsBooking) { parts.push('Ready when you are — book your slot here: ' + String(cfg.booking_url || '') + '?contact_id=' + session.contact_id); }
return [{ json: {
  contact_id: session.contact_id, reply: parts.join('\\n\\n'), matched: matched,
  matched_faq_id: matched ? best.faq_id : '', match_score: Math.round(bestScore * 100) / 100,
  is_new_contact: session.is_new_contact, attribution: session.attribution,
  source_post_id: session.source_post_id, inbound_text: msg.raw_text, channel: msg.platform,
  offered_booking: wantsBooking
}}];` } },
  output: [{ contact_id: 'CT-1', reply: 'Hi Ana!', matched: false, match_score: 0, offered_booking: false }]
});
const chatMsgRows = node({
  type: 'n8n-nodes-base.code', version: 2,
  config: { name: 'C11 Build Message Rows', position: [3600, 1400], parameters: { mode: 'runOnceForAllItems', language: 'javaScript',
    jsCode: `const r = $('C10 Compose Reply').first().json;
const now = Date.now(); const cv = 'CV-' + r.contact_id; const rows = [];
if (r.inbound_text) {
  rows.push({ json: { message_id: 'M' + now.toString(36) + 'i', conversation_id: cv, contact_id: r.contact_id,
    direction: 'inbound', channel: r.channel, body: String(r.inbound_text).slice(0, 2000), tokens_used: 0, created_at: new Date(now).toISOString() } });
}
rows.push({ json: { message_id: 'M' + now.toString(36) + 'o', conversation_id: cv, contact_id: r.contact_id,
  direction: 'outbound', channel: r.channel, body: String(r.reply).slice(0, 2000), tokens_used: 0, created_at: new Date(now + 1).toISOString() } });
return rows;` } },
  output: [{ message_id: 'M1i', direction: 'inbound' }]
});
const chatLog = node({
  type: 'n8n-nodes-base.dataTable', version: 1.1,
  config: { name: 'C12 Log Messages', position: [3960, 1400], onError: 'continueRegularOutput', parameters: { resource: 'row', operation: 'insert',
    dataTableId: { __rl: true, mode: 'list', value: '0wUEjoGnx593ZluM', cachedResultName: 'messages' },
    columns: { mappingMode: 'autoMapInputData', value: null, matchingColumns: [] } } },
  output: [{ id: 1 }]
});
const chatOut = node({
  type: 'n8n-nodes-base.respondToWebhook', version: 1.5,
  config: { name: 'C13 Deliver Reply', position: [4320, 1400], parameters: { respondWith: 'json',
    responseBody: expr("{{ { reply: $('C10 Compose Reply').first().json.reply, contact_id: $('C10 Compose Reply').first().json.contact_id, is_new_contact: $('C10 Compose Reply').first().json.is_new_contact, matched_faq_id: $('C10 Compose Reply').first().json.matched_faq_id, match_score: $('C10 Compose Reply').first().json.match_score, attribution: $('C10 Compose Reply').first().json.attribution, source_post_id: $('C10 Compose Reply').first().json.source_post_id, offered_booking: $('C10 Compose Reply').first().json.offered_booking } }}"),
    options: { responseCode: 200 } } },
  output: [{}]
});

const bookForm = trigger({
  type: 'n8n-nodes-base.formTrigger', version: 2.6,
  config: { name: 'D1 Booking Form', position: [0, 2200], parameters: {
    formTitle: 'Book your session', formDescription: 'Pick a slot and pay the deposit to confirm.',
    responseMode: 'lastNode',
    formFields: { values: [
      { fieldLabel: 'Full name', fieldType: 'text', requiredField: true },
      { fieldLabel: 'Email', fieldType: 'email', requiredField: true },
      { fieldLabel: 'Phone', fieldType: 'text', requiredField: true },
      { fieldLabel: 'Preferred date', fieldType: 'date', requiredField: true },
      { fieldLabel: 'Preferred time', fieldType: 'dropdown', requiredField: true,
        fieldOptions: { values: [{ option: '09:00' }, { option: '11:00' }, { option: '13:00' }, { option: '15:00' }, { option: '17:00' }] } }
    ] },
    options: { appendAttribution: false, buttonLabel: 'Check availability' } } },
  output: [{ 'Full name': 'Ana Reyes', Email: 'ana@example.com', Phone: '+639170000000', 'Preferred date': '2026-09-03', 'Preferred time': '11:00' }]
});
const bookCfg = node({
  type: 'n8n-nodes-base.set', version: 3.5,
  config: { name: 'D2 Booking Config', position: [360, 2200], parameters: { mode: 'manual', includeOtherFields: false,
    assignments: { assignments: [
      { id: 'z1', name: 'service', value: 'Studio session', type: 'string' },
      { id: 'z2', name: 'currency', value: 'PHP', type: 'string' },
      { id: 'z3', name: 'total_amount', value: 4500, type: 'number' },
      { id: 'z4', name: 'deposit_amount', value: 1500, type: 'number' },
      { id: 'z5', name: 'hold_minutes', value: 20, type: 'number' },
      { id: 'z6', name: 'pay_url', value: 'https://gipre.app.n8n.cloud/webhook/pay', type: 'string' }
    ] } } },
  output: [{ service: 'Studio session', total_amount: 4500, deposit_amount: 1500 }]
});
const bookAvail = node({
  type: 'n8n-nodes-base.code', version: 2,
  config: { name: 'D3 Check Availability', position: [720, 2200], parameters: { mode: 'runOnceForAllItems', language: 'javaScript',
    jsCode: `const f = $('D1 Booking Form').first().json || {};
const cfg = $input.first().json || {};
const date = String(f['Preferred date'] || '').trim();
const time = String(f['Preferred time'] || '').trim();
const slotStart = date + 'T' + time + ':00.000Z';
function hashOf(s) { let v = 0; for (let i = 0; i < s.length; i++) { v = ((v << 5) - v + s.charCodeAt(i)) | 0; } return Math.abs(v); }
const busy = hashOf(slotStart) % 4 === 0;
const start = new Date(slotStart);
const end = new Date(start.getTime() + 90 * 60000);
const hold = new Date(Date.now() + (Number(cfg.hold_minutes) || 20) * 60000);
return [{ json: {
  free: !busy, slot_start: slotStart, slot_end: end.toISOString(), hold_expires_at: hold.toISOString(),
  booking_id: 'BK-' + Date.now().toString(36).toUpperCase(),
  full_name: String(f['Full name'] || '').slice(0, 120), email: String(f.Email || '').slice(0, 160), phone: String(f.Phone || '').slice(0, 40),
  service: cfg.service, currency: cfg.currency, total_amount: Number(cfg.total_amount) || 0,
  deposit_amount: Number(cfg.deposit_amount) || 0, balance_due: (Number(cfg.total_amount) || 0) - (Number(cfg.deposit_amount) || 0),
  pay_url: cfg.pay_url
}}];` } },
  output: [{ free: true, slot_start: '2026-09-03T11:00:00.000Z', booking_id: 'BK-ABC', deposit_amount: 1500 }]
});
const bookFree = ifElse({
  version: 2.3,
  config: { name: 'D4 Slot Free?', position: [1080, 2200], parameters: {
    conditions: { options: { caseSensitive: false, leftValue: '', typeValidation: 'loose' },
      conditions: [{ leftValue: expr('{{ $json.free }}'), operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' },
    looseTypeValidation: true } }
});
const bookRow = node({
  type: 'n8n-nodes-base.code', version: 2,
  config: { name: 'D5 Build Booking Row', position: [1440, 2060], parameters: { mode: 'runOnceForAllItems', language: 'javaScript',
    jsCode: `const a = $input.first().json;
const q = ($('D1 Booking Form').first().json || {}).query || {};
const now = new Date().toISOString();
return [{ json: {
  booking_id: a.booking_id, contact_id: String(q.contact_id || ''), post_id: '', attribution: '',
  stage: 'form_submitted', service: a.service, slot_start: a.slot_start, slot_end: a.slot_end,
  hold_expires_at: a.hold_expires_at, full_name: a.full_name, email: a.email, phone: a.phone,
  currency: a.currency, total_amount: a.total_amount, deposit_amount: a.deposit_amount, balance_due: a.balance_due,
  calendar_event_id: '', chase_count: 0, last_chased_at: null, created_at: now, updated_at: now
}}];` } },
  output: [{ booking_id: 'BK-ABC', stage: 'form_submitted' }]
});
const bookSave = node({
  type: 'n8n-nodes-base.dataTable', version: 1.1,
  config: { name: 'D6 Save Booking', position: [1800, 2060], parameters: { resource: 'row', operation: 'upsert',
    dataTableId: { __rl: true, mode: 'list', value: 'ynKLNy71EOot9haS', cachedResultName: 'bookings' },
    matchType: 'allConditions',
    filters: { conditions: [{ keyName: 'booking_id', condition: 'eq', keyValue: expr('{{ $json.booking_id }}') }] },
    columns: { mappingMode: 'autoMapInputData', value: null, matchingColumns: [] } } },
  output: [{ id: 1 }]
});
const bookPay = node({
  type: 'n8n-nodes-base.form', version: 2.5,
  config: { name: 'D7 Show Deposit Link', position: [2160, 2060], parameters: { operation: 'completion', respondWith: 'showText',
    responseText: expr("{{ '<h2>Slot held for you</h2><p>' + $('D3 Check Availability').first().json.slot_start + '</p><p>Deposit ' + $('D3 Check Availability').first().json.currency + ' ' + $('D3 Check Availability').first().json.deposit_amount + ' — balance ' + $('D3 Check Availability').first().json.balance_due + ' on the day.</p><p><a href=\"' + $('D3 Check Availability').first().json.pay_url + '?booking_id=' + $('D3 Check Availability').first().json.booking_id + '&outcome=success\">Pay deposit (simulated)</a></p><p><a href=\"' + $('D3 Check Availability').first().json.pay_url + '?booking_id=' + $('D3 Check Availability').first().json.booking_id + '&outcome=fail\">Simulate a failed payment</a></p>' }}") } },
  output: [{}]
});
const bookTaken = node({
  type: 'n8n-nodes-base.form', version: 2.5,
  config: { name: 'D8 Slot Taken', position: [1440, 2340], parameters: { operation: 'completion', respondWith: 'text',
    completionTitle: 'That slot has gone', completionMessage: 'Someone booked it just before you. Head back and pick another time — nothing has been charged.' } },
  output: [{}]
});

const payIn = trigger({
  type: 'n8n-nodes-base.webhook', version: 2.1,
  config: { name: 'E1 Payment Callback', position: [0, 2900], parameters: { httpMethod: 'GET', path: 'pay', responseMode: 'responseNode' } },
  output: [{ query: { booking_id: 'BK-ABC', outcome: 'success' } }]
});
const payLoad = node({
  type: 'n8n-nodes-base.dataTable', version: 1.1,
  config: { name: 'E2 Load Booking', position: [360, 2900], alwaysOutputData: true, parameters: { resource: 'row', operation: 'get',
    dataTableId: { __rl: true, mode: 'list', value: 'ynKLNy71EOot9haS', cachedResultName: 'bookings' },
    matchType: 'allConditions',
    filters: { conditions: [{ keyName: 'booking_id', condition: 'eq', keyValue: expr('{{ $json.query.booking_id || "__none__" }}') }] },
    returnAll: false, limit: 1 } },
  output: [{ booking_id: 'BK-ABC', stage: 'form_submitted', slot_start: '2026-09-03T11:00:00.000Z', deposit_amount: 1500 }]
});
const payCheck = node({
  type: 'n8n-nodes-base.code', version: 2,
  config: { name: 'E3 Verify and Re-check Slot', position: [720, 2900], parameters: { mode: 'runOnceForAllItems', language: 'javaScript',
    jsCode: `const q = ($('E1 Payment Callback').first().json || {}).query || {};
const rows = $('E2 Load Booking').all().map(function (i) { return i.json; }).filter(function (r) { return r && r.booking_id; });
const bk = rows[0] || null;
const outcome = String(q.outcome || 'success').toLowerCase();
function hashOf(s) { let v = 0; for (let i = 0; i < s.length; i++) { v = ((v << 5) - v + s.charCodeAt(i)) | 0; } return Math.abs(v); }
const stillFree = bk ? hashOf(String(bk.slot_start)) % 4 !== 0 : false;
let status = 'confirmed';
if (!bk) { status = 'not_found'; }
else if (outcome !== 'success') { status = 'payment_failed'; }
else if (!stillFree) { status = 'slot_lost_refunded'; }
return [{ json: {
  status: status, found: bk !== null, booking: bk || {},
  booking_id: bk ? bk.booking_id : String(q.booking_id || ''),
  calendar_event_id: status === 'confirmed' ? 'CAL-' + Date.now().toString(36).toUpperCase() : ''
}}];` } },
  output: [{ status: 'confirmed', found: true, booking_id: 'BK-ABC', calendar_event_id: 'CAL-X' }]
});
const payOk = ifElse({
  version: 2.3,
  config: { name: 'E4 Confirmed?', position: [1080, 2900], parameters: {
    conditions: { options: { caseSensitive: false, leftValue: '', typeValidation: 'loose' },
      conditions: [{ leftValue: expr('{{ $json.status }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'confirmed' }], combinator: 'and' },
    looseTypeValidation: true } }
});
const payRecord = node({
  type: 'n8n-nodes-base.code', version: 2,
  config: { name: 'E5 Build Payment Row', position: [1440, 2760], parameters: { mode: 'runOnceForAllItems', language: 'javaScript',
    jsCode: `const r = $input.first().json; const bk = r.booking || {};
return [{ json: {
  payment_id: 'PY-' + Date.now().toString(36).toUpperCase(), booking_id: r.booking_id,
  provider: 'simulated', provider_ref: 'sim_' + Date.now().toString(36), kind: 'deposit',
  amount: Number(bk.deposit_amount) || 0, currency: String(bk.currency || 'PHP'),
  status: 'succeeded', error: '', created_at: new Date().toISOString()
}}];` } },
  output: [{ payment_id: 'PY-1', status: 'succeeded' }]
});
const paySave = node({
  type: 'n8n-nodes-base.dataTable', version: 1.1,
  config: { name: 'E6 Record Payment', position: [1800, 2760], parameters: { resource: 'row', operation: 'insert',
    dataTableId: { __rl: true, mode: 'list', value: 'sHC4mr6HRvj84BHb', cachedResultName: 'payments' },
    columns: { mappingMode: 'autoMapInputData', value: null, matchingColumns: [] } } },
  output: [{ id: 1 }]
});
const payBooking = node({
  type: 'n8n-nodes-base.code', version: 2,
  config: { name: 'E7 Build Confirmed Booking', position: [2160, 2760], parameters: { mode: 'runOnceForAllItems', language: 'javaScript',
    jsCode: `const r = $('E3 Verify and Re-check Slot').first().json; const bk = r.booking || {};
return [{ json: {
  booking_id: bk.booking_id, contact_id: bk.contact_id || '', post_id: bk.post_id || '', attribution: bk.attribution || '',
  stage: 'confirmed', service: bk.service || '', slot_start: bk.slot_start || null, slot_end: bk.slot_end || null,
  hold_expires_at: bk.hold_expires_at || null, full_name: bk.full_name || '', email: bk.email || '', phone: bk.phone || '',
  currency: bk.currency || 'PHP', total_amount: Number(bk.total_amount) || 0, deposit_amount: Number(bk.deposit_amount) || 0,
  balance_due: Number(bk.balance_due) || 0, calendar_event_id: r.calendar_event_id,
  chase_count: Number(bk.chase_count) || 0, last_chased_at: bk.last_chased_at || null,
  created_at: bk.created_at || new Date().toISOString(), updated_at: new Date().toISOString()
}}];` } },
  output: [{ booking_id: 'BK-ABC', stage: 'confirmed' }]
});
const payUpdate = node({
  type: 'n8n-nodes-base.dataTable', version: 1.1,
  config: { name: 'E8 Confirm Booking', position: [2520, 2760], parameters: { resource: 'row', operation: 'upsert',
    dataTableId: { __rl: true, mode: 'list', value: 'ynKLNy71EOot9haS', cachedResultName: 'bookings' },
    matchType: 'allConditions',
    filters: { conditions: [{ keyName: 'booking_id', condition: 'eq', keyValue: expr('{{ $json.booking_id }}') }] },
    columns: { mappingMode: 'autoMapInputData', value: null, matchingColumns: [] } } },
  output: [{ id: 1 }]
});
const payNotify = node({
  type: 'n8n-nodes-base.code', version: 2,
  config: { name: 'E9 Build Receipt and SMS', position: [2880, 2760], parameters: { mode: 'runOnceForAllItems', language: 'javaScript',
    jsCode: `const bk = $('E7 Build Confirmed Booking').first().json;
const now = Date.now();
return [
  { json: { notification_id: 'NT' + now.toString(36) + 'e', booking_id: bk.booking_id, contact_id: bk.contact_id,
    channel: 'email', template: 'deposit_receipt', recipient: bk.email, status: 'sent',
    provider_ref: 'sim_email_' + now.toString(36), error: '', sent_at: new Date(now).toISOString() } },
  { json: { notification_id: 'NT' + now.toString(36) + 's', booking_id: bk.booking_id, contact_id: bk.contact_id,
    channel: 'sms', template: 'booking_confirmed', recipient: bk.phone, status: 'sent',
    provider_ref: 'sim_sms_' + now.toString(36), error: '', sent_at: new Date(now + 1).toISOString() } }
];` } },
  output: [{ notification_id: 'NT1e', channel: 'email', status: 'sent' }]
});
const payNotifSave = node({
  type: 'n8n-nodes-base.dataTable', version: 1.1,
  config: { name: 'E10 Log Notifications', position: [3240, 2760], onError: 'continueRegularOutput', parameters: { resource: 'row', operation: 'insert',
    dataTableId: { __rl: true, mode: 'list', value: 'm7De7p3q16f2B1kA', cachedResultName: 'notifications' },
    columns: { mappingMode: 'autoMapInputData', value: null, matchingColumns: [] } } },
  output: [{ id: 1 }]
});
const payDone = node({
  type: 'n8n-nodes-base.respondToWebhook', version: 1.5,
  config: { name: 'E11 Confirm Page', position: [3600, 2760], parameters: { respondWith: 'text',
    responseBody: expr("{{ 'Booking ' + $('E7 Build Confirmed Booking').first().json.booking_id + ' confirmed for ' + $('E7 Build Confirmed Booking').first().json.slot_start + '. Receipt emailed and SMS sent (simulated). Balance ' + $('E7 Build Confirmed Booking').first().json.currency + ' ' + $('E7 Build Confirmed Booking').first().json.balance_due + ' due on the day.' }}"),
    options: { responseCode: 200 } } },
  output: [{}]
});
const payFail = node({
  type: 'n8n-nodes-base.respondToWebhook', version: 1.5,
  config: { name: 'E12 Not Confirmed', position: [1440, 3040], parameters: { respondWith: 'text',
    responseBody: expr("{{ 'Not confirmed — ' + $('E3 Verify and Re-check Slot').first().json.status + '. If the slot was lost after payment the deposit is refunded automatically (simulated).' }}"),
    options: { responseCode: 200 } } },
  output: [{}]
});

const nurTrig = trigger({
  type: 'n8n-nodes-base.scheduleTrigger', version: 1.4,
  config: { name: 'F1 Hourly Sweep', position: [0, 3700], parameters: { rule: { interval: [{ field: 'hours', hoursInterval: 1 }] } } },
  output: [{}]
});
const nurLoad = node({
  type: 'n8n-nodes-base.dataTable', version: 1.1,
  config: { name: 'F2 Load Bookings', position: [360, 3700], alwaysOutputData: true, parameters: { resource: 'row', operation: 'get',
    dataTableId: { __rl: true, mode: 'list', value: 'ynKLNy71EOot9haS', cachedResultName: 'bookings' }, returnAll: true } },
  output: [{ booking_id: 'BK-ABC', stage: 'form_submitted', chase_count: 0, created_at: '2026-08-26T00:00:00.000Z' }]
});
const nurFind = node({
  type: 'n8n-nodes-base.code', version: 2,
  config: { name: 'F3 Find Stalled', position: [720, 3700], parameters: { mode: 'runOnceForAllItems', language: 'javaScript',
    jsCode: `const STALLED = ['form_opened', 'form_submitted', 'checkout_started'];
const HOURS = 24; const MAX_CHASES = 1;
const now = Date.now();
const rows = $input.all().map(function (i) { return i.json; }).filter(function (r) { return r && r.booking_id; });
const due = rows.filter(function (r) {
  if (STALLED.indexOf(String(r.stage)) === -1) { return false; }
  if ((Number(r.chase_count) || 0) >= MAX_CHASES) { return false; }
  const age = now - new Date(r.created_at || 0).getTime();
  return age >= HOURS * 3600000;
});
return due.map(function (r) { return { json: r }; });` } },
  output: [{ booking_id: 'BK-ABC', stage: 'form_submitted', chase_count: 0 }]
});
const nurBuild = node({
  type: 'n8n-nodes-base.code', version: 2,
  config: { name: 'F4 Build Chase Rows', position: [1080, 3700], parameters: { mode: 'runOnceForAllItems', language: 'javaScript',
    jsCode: `const now = Date.now();
const out = [];
$input.all().forEach(function (item, idx) {
  const r = item.json;
  out.push({ json: { notification_id: 'NT' + now.toString(36) + 'c' + idx, booking_id: r.booking_id,
    contact_id: r.contact_id || '', channel: r.phone ? 'sms' : 'email', template: 'stalled_' + r.stage,
    recipient: r.phone || r.email || '', status: 'sent', provider_ref: 'sim_chase_' + now.toString(36) + idx,
    error: '', sent_at: new Date(now + idx).toISOString() } });
});
return out;` } },
  output: [{ notification_id: 'NT1c0', channel: 'sms', template: 'stalled_form_submitted' }]
});
const nurLog = node({
  type: 'n8n-nodes-base.dataTable', version: 1.1,
  config: { name: 'F5 Log Chase', position: [1440, 3700], onError: 'continueRegularOutput', parameters: { resource: 'row', operation: 'insert',
    dataTableId: { __rl: true, mode: 'list', value: 'm7De7p3q16f2B1kA', cachedResultName: 'notifications' },
    columns: { mappingMode: 'autoMapInputData', value: null, matchingColumns: [] } } },
  output: [{ id: 1 }]
});
const nurMark = node({
  type: 'n8n-nodes-base.code', version: 2,
  config: { name: 'F6 Build Chased Bookings', position: [1800, 3700], parameters: { mode: 'runOnceForAllItems', language: 'javaScript',
    jsCode: `const now = new Date().toISOString();
return $('F3 Find Stalled').all().map(function (item) {
  const bk = item.json;
  return { json: {
    booking_id: bk.booking_id, contact_id: bk.contact_id || '', post_id: bk.post_id || '', attribution: bk.attribution || '',
    stage: bk.stage, service: bk.service || '', slot_start: bk.slot_start || null, slot_end: bk.slot_end || null,
    hold_expires_at: bk.hold_expires_at || null, full_name: bk.full_name || '', email: bk.email || '', phone: bk.phone || '',
    currency: bk.currency || 'PHP', total_amount: Number(bk.total_amount) || 0, deposit_amount: Number(bk.deposit_amount) || 0,
    balance_due: Number(bk.balance_due) || 0, calendar_event_id: bk.calendar_event_id || '',
    chase_count: (Number(bk.chase_count) || 0) + 1, last_chased_at: now,
    created_at: bk.created_at || now, updated_at: now
  }};
});` } },
  output: [{ booking_id: 'BK-ABC', chase_count: 1 }]
});
const nurSave = node({
  type: 'n8n-nodes-base.dataTable', version: 1.1,
  config: { name: 'F7 Mark Chased', position: [2160, 3700], parameters: { resource: 'row', operation: 'upsert',
    dataTableId: { __rl: true, mode: 'list', value: 'ynKLNy71EOot9haS', cachedResultName: 'bookings' },
    matchType: 'allConditions',
    filters: { conditions: [{ keyName: 'booking_id', condition: 'eq', keyValue: expr('{{ $json.booking_id }}') }] },
    columns: { mappingMode: 'autoMapInputData', value: null, matchingColumns: [] } } },
  output: [{ id: 1 }]
});

const dashIn = trigger({
  type: 'n8n-nodes-base.webhook', version: 2.1,
  config: { name: 'G1 Dashboard Request', position: [0, 4400], parameters: { httpMethod: 'GET', path: 'dashboard', responseMode: 'responseNode' } },
  output: [{ query: {} }]
});
const dashClicks = node({
  type: 'n8n-nodes-base.dataTable', version: 1.1,
  config: { name: 'G2 Read click_events', position: [360, 4400], alwaysOutputData: true, parameters: { resource: 'row', operation: 'get',
    dataTableId: { __rl: true, mode: 'list', value: 'PGHVw6wnYmJ2umyp', cachedResultName: 'click_events' }, returnAll: true } },
  output: [{ click_id: 'C1', post_id: 'post_001', is_bot: false }]
});
const dashBookings = node({
  type: 'n8n-nodes-base.dataTable', version: 1.1,
  config: { name: 'G3 Read bookings', executeOnce: true, position: [720, 4400], alwaysOutputData: true, parameters: { resource: 'row', operation: 'get',
    dataTableId: { __rl: true, mode: 'list', value: 'ynKLNy71EOot9haS', cachedResultName: 'bookings' }, returnAll: true } },
  output: [{ booking_id: 'BK-ABC', stage: 'confirmed' }]
});
const dashMsgs = node({
  type: 'n8n-nodes-base.dataTable', version: 1.1,
  config: { name: 'G4 Read messages', executeOnce: true, position: [1080, 4400], alwaysOutputData: true, parameters: { resource: 'row', operation: 'get',
    dataTableId: { __rl: true, mode: 'list', value: '0wUEjoGnx593ZluM', cachedResultName: 'messages' }, returnAll: true } },
  output: [{ message_id: 'M1', direction: 'inbound' }]
});
const dashNotifs = node({
  type: 'n8n-nodes-base.dataTable', version: 1.1,
  config: { name: 'G5 Read notifications', executeOnce: true, position: [1440, 4400], alwaysOutputData: true, parameters: { resource: 'row', operation: 'get',
    dataTableId: { __rl: true, mode: 'list', value: 'm7De7p3q16f2B1kA', cachedResultName: 'notifications' }, returnAll: true } },
  output: [{ notification_id: 'NT1', channel: 'email', status: 'sent' }]
});
const dashOps = node({
  type: 'n8n-nodes-base.dataTable', version: 1.1,
  config: { name: 'G6 Read ops_events', executeOnce: true, position: [1800, 4400], alwaysOutputData: true, parameters: { resource: 'row', operation: 'get',
    dataTableId: { __rl: true, mode: 'list', value: 'RnlzXRfhSe8rRWiq', cachedResultName: 'ops_events' }, returnAll: true } },
  output: [{ event_id: 'E1', level: 'error' }]
});
const dashData = node({
  type: 'n8n-nodes-base.code', version: 2,
  config: { name: 'G9 Build Datasets', position: [2160, 4400], parameters: { mode: 'runOnceForAllItems', language: 'javaScript',
    jsCode: `function rows(n) { return $(n).all().map(function (i) { return i.json; }).filter(function (r) { return r && Object.keys(r).length > 1; }); }
const clicks = rows('G2 Read click_events');
const bookings = rows('G3 Read bookings');
const msgs = rows('G4 Read messages');
const notifs = rows('G5 Read notifications');
const ops = rows('G6 Read ops_events');

const humanClicks = clicks.filter(function (c) { return c.is_bot !== true; });
const STAGES = ['clicked','chatted','form_opened','form_submitted','checkout_started','deposit_paid','confirmed'];
const stageCount = {};
STAGES.forEach(function (s) { stageCount[s] = 0; });
bookings.forEach(function (b) { if (stageCount[b.stage] !== undefined) { stageCount[b.stage] += 1; } });

const byPost = {};
humanClicks.forEach(function (c) {
  const k = c.post_id || 'unknown';
  if (!byPost[k]) { byPost[k] = { post_id: k, clicks: 0, exact_attribution: 0 }; }
  byPost[k].clicks += 1;
  if (c.attribution === 'exact') { byPost[k].exact_attribution += 1; }
});
const posts = Object.keys(byPost).map(function (k) { return byPost[k]; }).sort(function (a, b) { return b.clicks - a.clicks; });

const STALLED = ['form_opened','form_submitted','checkout_started'];
const leads = bookings.filter(function (b) { return STALLED.indexOf(b.stage) !== -1; }).map(function (b) {
  return { booking_id: b.booking_id || '', contact_id: b.contact_id || '', stage: b.stage || '',
    full_name: b.full_name || '', email: b.email || '', phone: b.phone || '',
    preferred_channel: b.phone ? 'sms' : 'email',
    chase_count: Number(b.chase_count) || 0, last_chased_at: b.last_chased_at || '',
    slot_start: b.slot_start || '', deposit_amount: Number(b.deposit_amount) || 0,
    currency: b.currency || '', post_id: b.post_id || '', attribution: b.attribution || '',
    created_at: b.created_at || '' };
});

const events = [];
clicks.forEach(function (c) { events.push({ fact_type: 'click', event_id: c.click_id || '', occurred_at: c.clicked_at || '', contact_id: '', booking_id: '', post_id: c.post_id || '', channel: c.platform || '', attribution: c.attribution || '', stage: '', direction: '', status: c.is_bot ? 'bot' : 'human', template: '', amount: 0, currency: '', level: '', node_name: '', detail: '' }); });
bookings.forEach(function (b) { events.push({ fact_type: 'booking', event_id: b.booking_id || '', occurred_at: b.created_at || '', contact_id: b.contact_id || '', booking_id: b.booking_id || '', post_id: b.post_id || '', channel: '', attribution: b.attribution || '', stage: b.stage || '', direction: '', status: b.stage || '', template: '', amount: Number(b.deposit_amount) || 0, currency: b.currency || '', level: '', node_name: '', detail: b.slot_start || '' }); });
msgs.forEach(function (m) { events.push({ fact_type: 'message', event_id: m.message_id || '', occurred_at: m.created_at || '', contact_id: m.contact_id || '', booking_id: '', post_id: '', channel: m.channel || '', attribution: '', stage: '', direction: m.direction || '', status: '', template: '', amount: 0, currency: '', level: '', node_name: '', detail: String(m.body || '').slice(0, 200) }); });
notifs.forEach(function (n) { events.push({ fact_type: 'notification', event_id: n.notification_id || '', occurred_at: n.sent_at || '', contact_id: n.contact_id || '', booking_id: n.booking_id || '', post_id: '', channel: n.channel || '', attribution: '', stage: '', direction: 'outbound', status: n.status || '', template: n.template || '', amount: 0, currency: '', level: '', node_name: '', detail: n.recipient || '' }); });
ops.forEach(function (o) { events.push({ fact_type: 'ops_event', event_id: o.event_id || '', occurred_at: o.created_at || '', contact_id: '', booking_id: '', post_id: '', channel: '', attribution: '', stage: '', direction: '', status: '', template: '', amount: 0, currency: '', level: o.level || '', node_name: o.node_name || '', detail: String(o.message || '').slice(0, 300) }); });
events.sort(function (a, b) { return String(a.occurred_at) < String(b.occurred_at) ? 1 : -1; });

return [{ json: {
  generated_at: new Date().toISOString(),
  kpis: {
    human_clicks: humanClicks.length, bot_clicks: clicks.length - humanClicks.length,
    messages_in: msgs.filter(function (m) { return m.direction === 'inbound'; }).length,
    messages_out: msgs.filter(function (m) { return m.direction === 'outbound'; }).length,
    bookings: bookings.length, confirmed: stageCount.confirmed,
    emails_sent: notifs.filter(function (n) { return n.channel === 'email'; }).length,
    sms_sent: notifs.filter(function (n) { return n.channel === 'sms'; }).length,
    notifications_failed: notifs.filter(function (n) { return n.status !== 'sent'; }).length,
    errors: ops.filter(function (o) { return o.level === 'error'; }).length,
    leads_to_follow_up: leads.length
  },
  funnel: STAGES.map(function (s) { return { stage: s, count: stageCount[s] }; }),
  posts: posts,
  leads: leads,
  events: events
}}];` } },
  output: [{ generated_at: '2026-01-01T00:00:00.000Z', kpis: { human_clicks: 2, bookings: 2 }, funnel: [], posts: [], leads: [], events: [] }]
});
const dashFormat = switchCase({
  version: 3.4,
  config: { name: 'G10 Which Format?', position: [2520, 4400], parameters: {
    mode: 'rules',
    rules: { values: [
      { conditions: { options: { caseSensitive: false, leftValue: '', typeValidation: 'loose' },
          conditions: [{ leftValue: expr("{{ ($('G1 Dashboard Request').first().json.query || {}).format || 'html' }}"), operator: { type: 'string', operation: 'equals' }, rightValue: 'json' }], combinator: 'and' },
        renameOutput: true, outputKey: 'json' },
      { conditions: { options: { caseSensitive: false, leftValue: '', typeValidation: 'loose' },
          conditions: [{ leftValue: expr("{{ ($('G1 Dashboard Request').first().json.query || {}).format || 'html' }}"), operator: { type: 'string', operation: 'equals' }, rightValue: 'csv' }], combinator: 'and' },
        renameOutput: true, outputKey: 'csv' }
    ] },
    looseTypeValidation: true,
    options: { fallbackOutput: 'extra', renameFallbackOutput: 'html' } } }
});
const dashRender = node({
  type: 'n8n-nodes-base.code', version: 2,
  config: { name: 'G7 Render Dashboard', position: [2880, 4060], parameters: { mode: 'runOnceForAllItems', language: 'javaScript',
    jsCode: `const d = $('G9 Build Datasets').first().json;
const k = d.kpis;
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function tile(label, value, sub) {
  return '<div class="t"><div class="v">' + esc(value) + '</div><div class="k">' + esc(label) + '</div>' + (sub ? '<div class="s">' + esc(sub) + '</div>' : '') + '</div>';
}
const funnelRows = d.funnel.map(function (f) { return '<tr><td>' + esc(f.stage) + '</td><td class="n">' + f.count + '</td></tr>'; }).join('');
const postRows = d.posts.length ? d.posts.map(function (p) { return '<tr><td>' + esc(p.post_id) + '</td><td class="n">' + p.clicks + '</td><td class="n">' + p.exact_attribution + '</td></tr>'; }).join('') : '<tr><td colspan="3">No clicks yet</td></tr>';
const leadRows = d.leads.length ? d.leads.map(function (b) { return '<tr><td>' + esc(b.booking_id) + '</td><td>' + esc(b.stage) + '</td><td>' + esc(b.full_name) + '</td><td>' + esc(b.phone || b.email) + '</td><td>' + esc(b.preferred_channel) + '</td><td class="n">' + b.chase_count + '</td></tr>'; }).join('') : '<tr><td colspan="6">Nobody stalled</td></tr>';
const fails = d.events.filter(function (e) { return e.fact_type === 'ops_event'; }).slice(0, 8);
const errRows = fails.length ? fails.map(function (o) { return '<tr><td>' + esc(o.occurred_at) + '</td><td>' + esc(o.node_name) + '</td><td>' + esc(o.detail) + '</td></tr>'; }).join('') : '<tr><td colspan="3">No failures recorded</td></tr>';

const css = 'body{margin:0;background:#0e1117;color:#e6e8ef;font:15px/1.55 ui-sans-serif,system-ui,sans-serif}'
  + '.w{max-width:1080px;margin:0 auto;padding:36px 24px 80px}'
  + 'h1{font-size:30px;margin:0 0 4px;letter-spacing:-.02em}'
  + '.sub{color:#8b93a8;margin:0 0 28px;font-size:14px}'
  + 'h2{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#8e9bf0;margin:34px 0 12px}'
  + '.g{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1px;background:#252a38;border:1px solid #252a38;border-radius:5px;overflow:hidden}'
  + '.t{background:#161a24;padding:16px 18px}.t .v{font-size:26px;font-weight:600}.t .k{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#8b93a8;margin-top:6px}.t .s{font-size:11px;color:#6c7488;margin-top:4px}'
  + 'table{width:100%;border-collapse:collapse;background:#161a24;border:1px solid #252a38;border-radius:5px;overflow:hidden;font-size:14px}'
  + 'th{text-align:left;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#8b93a8;padding:10px 14px;border-bottom:1px solid #252a38}'
  + 'td{padding:10px 14px;border-bottom:1px solid #1d2230}tr:last-child td{border-bottom:0}'
  + 'td.n{text-align:right;font-variant-numeric:tabular-nums}'
  + '.x{background:#161a24;border:1px solid #252a38;border-radius:5px;padding:14px 18px;font-size:14px;line-height:2.1}'
  + '.x a{color:#8e9bf0;text-decoration:none;border-bottom:1px solid #3a4260}.x span{color:#6c7488;font-size:13px}';

const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
  + '<title>Funnel Dashboard</title><style>' + css + '</style></head><body><div class="w">'
  + '<h1>Booking Funnel</h1><p class="sub">Simulated data · generated ' + d.generated_at + '</p>'
  + '<h2>Headline</h2><div class="g">'
  + tile('Human clicks', k.human_clicks, k.bot_clicks + ' bot hits excluded')
  + tile('Conversations', k.messages_in + k.messages_out, k.messages_in + ' in / ' + k.messages_out + ' out')
  + tile('Bookings', k.bookings, k.confirmed + ' confirmed')
  + tile('Emails sent', k.emails_sent, '')
  + tile('SMS sent', k.sms_sent, k.notifications_failed + ' failed')
  + tile('Errors', k.errors, '')
  + '</div>'
  + '<h2>Funnel</h2><table><tr><th>Stage</th><th style="text-align:right">Count</th></tr>' + funnelRows + '</table>'
  + '<h2>Post popularity</h2><table><tr><th>Post</th><th style="text-align:right">Clicks</th><th style="text-align:right">Exact attribution</th></tr>' + postRows + '</table>'
  + '<h2>Follow-up list · ' + k.leads_to_follow_up + '</h2><table><tr><th>Booking</th><th>Stage</th><th>Name</th><th>Contact</th><th>Chase via</th><th style="text-align:right">Chased</th></tr>' + leadRows + '</table>'
  + '<h2>Recent failures</h2><table><tr><th>When</th><th>Node</th><th>Message</th></tr>' + errRows + '</table>'
  + '<h2>Export</h2><div class="x">'
  + '<a href="?format=json">JSON — all datasets</a> <span>Power BI Web connector · Looker Studio</span><br>'
  + '<a href="?format=csv&amp;dataset=leads">CSV — leads to follow up</a> <span>Salesforce · GoHighLevel</span><br>'
  + '<a href="?format=csv&amp;dataset=events">CSV — event facts</a> <span>one row per click, booking, message, notification, failure</span><br>'
  + '<a href="?format=csv&amp;dataset=funnel">CSV — funnel counts</a> &nbsp; <a href="?format=csv&amp;dataset=posts">CSV — post popularity</a>'
  + '</div>'
  + '</div></body></html>';

return [{ json: { html: html } }];` } },
  output: [{ html: '<!doctype html>' }]
});
const dashServe = node({
  type: 'n8n-nodes-base.respondToWebhook', version: 1.5,
  config: { name: 'G8 Serve Page', position: [3240, 4060], parameters: { respondWith: 'text',
    responseBody: expr('{{ $json.html }}'),
    options: { responseCode: 200, responseHeaders: { entries: [{ name: 'content-type', value: 'text/html; charset=utf-8' }] } } } },
  output: [{}]
});
const dashJson = node({
  type: 'n8n-nodes-base.respondToWebhook', version: 1.5,
  config: { name: 'G11 Serve JSON', position: [2880, 4400], parameters: { respondWith: 'json',
    responseBody: expr('{{ $json }}'), options: { responseCode: 200 } } },
  output: [{}]
});
const dashCsvBuild = node({
  type: 'n8n-nodes-base.code', version: 2,
  config: { name: 'G12 Build CSV', position: [2880, 4740], parameters: { mode: 'runOnceForAllItems', language: 'javaScript',
    jsCode: `const d = $('G9 Build Datasets').first().json;
const q = ($('G1 Dashboard Request').first().json || {}).query || {};
const asked = String(q.dataset || 'leads').toLowerCase();
const SETS = { leads: d.leads, events: d.events, funnel: d.funnel, posts: d.posts };
const chosen = SETS[asked] ? asked : 'leads';
const rows = SETS[chosen];
function cell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\\n\\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
let csv = '';
if (!rows.length) { csv = 'no_rows\\n'; }
else {
  const cols = Object.keys(rows[0]);
  csv = cols.join(',') + '\\n';
  rows.forEach(function (r) { csv += cols.map(function (c) { return cell(r[c]); }).join(',') + '\\n'; });
}
return [{ json: { csv: csv, dataset: chosen, row_count: rows.length, filename: 'funnel-' + chosen + '.csv' } }];` } },
  output: [{ csv: 'booking_id,stage\n', dataset: 'leads', row_count: 1, filename: 'funnel-leads.csv' }]
});
const dashCsvServe = node({
  type: 'n8n-nodes-base.respondToWebhook', version: 1.5,
  config: { name: 'G13 Serve CSV', position: [3240, 4740], parameters: { respondWith: 'text',
    responseBody: expr('{{ $json.csv }}'),
    options: { responseCode: 200, responseHeaders: { entries: [
      { name: 'content-type', value: 'text/csv; charset=utf-8' },
      { name: 'content-disposition', value: expr('attachment; filename="{{ $json.filename }}"') }
    ] } } } },
  output: [{}]
});

const readme = sticky("# Booking Funnel — All in One\n## Every branch of the funnel on a single canvas. Fully simulated, zero credentials.\n\nSeven independent entry points share one workflow and one set of ten data tables. Each trigger runs its own isolated execution, so the branches never interfere with each other.\n\n| Branch | Entry point |\n| --- | --- |\n| **A** Error handler | fires on this workflow's own failures |\n| **B** Click router | `GET /webhook/go?p=post_001&c=telegram` |\n| **C** Chat + agent | `POST /webhook/chat` |\n| **D** Booking form | the form trigger's public URL |\n| **E** Payment callback | `GET /webhook/pay?booking_id=…&outcome=success` |\n| **F** Nurture sweep | hourly schedule |\n| **G** Dashboard | `GET /webhook/dashboard` |\n\n### What is simulated\nThe calendar (deterministic — a slot is busy if its hash mod 4 is zero, so the same slot always answers the same), the payment (a link with `outcome=success` or `fail`), the receipt email and SMS (rows written as if delivered), and the LLM (keyword scoring over the `faq` table).\n\n### The tradeoff you accepted\nOne workflow means activation is all-or-nothing — you cannot pause the hourly sweep without also taking down the webhooks. Fine for a simulation; revisit before real money moves through it.", [], {
  name: 'README', position: [0, -620], width: 1500, height: 520, color: 7
});
const banA = sticky("## A · Error handling\nAn Error Trigger inside the workflow it monitors — n8n fires it automatically on any production failure, no settings needed. Every failure becomes an `ops_events` row, which is what the dashboard's error count reads.", [], { name: 'Band A', position: [1120, -60], width: 700, height: 120, color: 3 });
const banB = sticky("## B · Click router — the entry point\nA tracked link in a post caption. Mints an attribution token, builds the platform's chat deep link, logs the click, then 302s. Bot hits are flagged, not dropped, so previewers cannot inflate your numbers.", [], { name: 'Band B', position: [2560, 640], width: 760, height: 120, color: 4 });
const banC = sticky("## C · Chat and agent\nTrades the token for the click row — this is where attribution actually happens. Answers from the `faq` table by keyword scoring, logs both sides, and offers the booking link when someone asks to book.", [], { name: 'Band C', position: [4720, 1340], width: 760, height: 120, color: 5 });
const banD = sticky("## D · Booking and deposit\nChecks the slot **before** taking money, holds it with an expiry, then shows a simulated payment link. A taken slot ends the form politely rather than charging for something unavailable.", [], { name: 'Band D', position: [2560, 2140], width: 760, height: 120, color: 4 });
const banE = sticky("## E · Payment and confirmation\n**Re-checks the slot after payment** — the race that would otherwise double-book. If it was lost, the deposit is refunded rather than the customer being quietly overbooked. On success: calendar event, receipt, SMS.", [], { name: 'Band E', position: [4000, 2840], width: 780, height: 120, color: 6 });
const banF = sticky("## F · Follow-up nurture\nHourly sweep for bookings stuck at `form_opened`, `form_submitted` or `checkout_started` for over 24 hours. Chases once, then stamps `chase_count` so nobody is pestered twice.", [], { name: 'Band F', position: [2560, 3640], width: 760, height: 120, color: 2 });
const banG = sticky("## G · Dashboard and exports\nReads all five tables once in **G9**, then serves the same numbers three ways off one endpoint: the HTML page by default, `?format=json` for Power BI and Looker Studio, and `?format=csv&dataset=…` for Salesforce and GoHighLevel. Aggregation lives in one node so the three formats cannot drift apart.", [], { name: 'Band G', position: [3600, 4380], width: 700, height: 140, color: 6 });

const cA1 = sticky("### A1 · Workflow Failed\n`Error Trigger`\n\n**In:** the failing execution, from n8n itself.\n**Out:** the raw error payload.", [], { name: 'c A1', position: [0, 140], width: 300, height: 190, color: 3 });
const cA2 = sticky("### A2 · Build Ops Event\n`Code`\n\n**Does:** flattens the nested error and clips every field so a stack trace cannot break the insert.\n**Out:** 1 `ops_events` row.", [], { name: 'c A2', position: [360, 140], width: 300, height: 200, color: 5 });
const cA3 = sticky("### A3 · Write ops_events\n`Data table` · insert\n\n**Out:** the stored row. Feeds the dashboard's error count.", [], { name: 'c A3', position: [720, 140], width: 300, height: 180, color: 6 });
const cB1 = sticky("### B1 · Inbound Click\n`Webhook` GET /go\n\n**In:** `?p=` post, `?c=` channel.\n**Out:** query + headers.\n\nThis is the link you put in a caption.", [], { name: 'c B1', position: [0, 840], width: 300, height: 200, color: 7 });
const cB2 = sticky("### B2 · Channel Config\n`Set`\n\n**Out:** your handle per platform.\n\n👉 **Edit this node.** Ships with placeholders.", [], { name: 'c B2', position: [360, 840], width: 300, height: 200, color: 4 });
const cB3 = sticky("### B3 · Resolve Redirect\n`Code`\n\n**Does:** mints the a-z0-9 token Telegram accepts, builds the deep link, sniffs the UA for crawlers.\n**Out:** `ok` `redirect_target` `attribution_token` `is_bot`", [], { name: 'c B3', position: [720, 840], width: 300, height: 230, color: 5 });
const cB4 = sticky("### B4 · Resolvable?\n`If`\n\n**true** → log then redirect\n**false** → 404 naming the fix", [], { name: 'c B4', position: [1080, 840], width: 300, height: 190, color: 5 });
const cB5 = sticky("### B5 · Shape Click Row\n`Set`\n\n**Does:** trims to exactly the 11 columns the table has.", [], { name: 'c B5', position: [1440, 320], width: 300, height: 180, color: 4 });
const cB6 = sticky("### B6 · Log Click\n`Data table` · insert\n\n🔁 Continues on error — losing a log row beats a dead link.", [], { name: 'c B6', position: [1800, 320], width: 300, height: 200, color: 6 });
const cB7 = sticky("### B7 · Redirect to Chat\n`Respond` 302\n\nReads the target back from B3 — the table node returns the row, not the target.", [], { name: 'c B7', position: [2160, 320], width: 300, height: 190, color: 6 });
const cB8 = sticky("### B8 · Unknown Channel\n`Respond` 404\n\nSays what to fix rather than failing silently.", [], { name: 'c B8', position: [1440, 1000], width: 300, height: 170, color: 3 });
const cC1 = sticky("### C1 · Inbound Message\n`Webhook` POST /chat\n\n**In:** `{platform, user_id, name, text}`\n\n🔧 Swap for a real platform trigger to go live.", [], { name: 'c C1', position: [0, 1540], width: 300, height: 200, color: 7 });
const cC2 = sticky("### C2 · Bot Config\n`Set`\n\n**Out:** `welcome` `fallback` `booking_url` `min_score`\n\n👉 **Edit this node.**", [], { name: 'c C2', position: [360, 1540], width: 300, height: 200, color: 4 });
const cC3 = sticky("### C3 · Normalize Inbound\n`Code`\n\n**Does:** finds the token wherever it hides — `/start x`, a `ref` field, or `[ref:x]` in WhatsApp prefill.", [], { name: 'c C3', position: [720, 1540], width: 300, height: 210, color: 5 });
const cC4 = sticky("### C4 · Lookup Click by Token\n`Data table` · get\n\n**This is where attribution happens.**\n⚠️ `alwaysOutputData` so a miss cannot kill the chain.", [], { name: 'c C4', position: [1080, 1540], width: 300, height: 210, color: 5 });
const cC5 = sticky("### C5 · Lookup Contact\n`Data table` · get\n\nMatches platform **and** user id — ids are only unique within a platform.", [], { name: 'c C5', position: [1440, 1540], width: 300, height: 200, color: 5 });
const cC6 = sticky("### C6 · Resolve Session\n`Code`\n\n**First touch wins:** a returning contact keeps their original post, so a second visit cannot steal the credit.", [], { name: 'c C6', position: [1800, 1540], width: 300, height: 220, color: 5 });
const cC7 = sticky("### C7 · Contact Row\n`Set`\n\nTrims to exactly the 10 `contacts` columns.", [], { name: 'c C7', position: [2160, 1540], width: 300, height: 170, color: 4 });
const cC8 = sticky("### C8 · Upsert Contact\n`Data table` · upsert\n\nOne node instead of check-then-write, so there is no race.", [], { name: 'c C8', position: [2520, 1540], width: 300, height: 190, color: 6 });
const cC9 = sticky("### C9 · Load FAQ\n`Data table` · get all\n\nThe knowledge base. Editing an answer is editing a row.", [], { name: 'c C9', position: [2880, 1540], width: 300, height: 190, color: 6 });
const cC10 = sticky("### C10 · Compose Reply\n`Code`\n\n**Does:** scores the question against each entry's question **and** tags. Below threshold it says so plainly rather than guessing.", [], { name: 'c C10', position: [3240, 1540], width: 300, height: 230, color: 5 });
const cC11 = sticky("### C11 · Build Message Rows\n`Code`\n\n**Out:** 2 rows — both sides of the exchange, written together.", [], { name: 'c C11', position: [3600, 1540], width: 300, height: 190, color: 4 });
const cC12 = sticky("### C12 · Log Messages\n`Data table` · insert\n\n🔁 A failed log must never cost the customer their reply.", [], { name: 'c C12', position: [3960, 1540], width: 300, height: 180, color: 6 });
const cC13 = sticky("### C13 · Deliver Reply\n`Respond` 200 JSON\n\nIn simulation this **is** the delivery.", [], { name: 'c C13', position: [4320, 1540], width: 300, height: 190, color: 6 });
const cD1 = sticky("### D1 · Booking Form\n`Form Trigger`\n\n**In:** name, email, phone, date, time.\n**Out:** the submission.", [], { name: 'c D1', position: [0, 2340], width: 300, height: 200, color: 7 });
const cD2 = sticky("### D2 · Booking Config\n`Set`\n\n**Out:** price, deposit, hold minutes.\n\n👉 **Edit this node.**", [], { name: 'c D2', position: [360, 2340], width: 300, height: 200, color: 4 });
const cD3 = sticky("### D3 · Check Availability\n`Code` · simulated calendar\n\nDeterministic: the same slot always answers the same.\n🔧 Swap for Google Calendar `availability`.", [], { name: 'c D3', position: [720, 2340], width: 300, height: 230, color: 5 });
const cD4 = sticky("### D4 · Slot Free?\n`If`\n\n**true** → hold and take a deposit\n**false** → say so, charge nothing", [], { name: 'c D4', position: [1080, 2340], width: 300, height: 180, color: 5 });
const cD5 = sticky("### D5 · Build Booking Row\n`Code`\n\n**Out:** 1 `bookings` row at stage `form_submitted`, with the hold expiry set.", [], { name: 'c D5', position: [1440, 1780], width: 300, height: 190, color: 4 });
const cD6 = sticky("### D6 · Save Booking\n`Data table` · upsert\n\nKeyed on `booking_id`.", [], { name: 'c D6', position: [1800, 1780], width: 300, height: 170, color: 6 });
const cD7 = sticky("### D7 · Show Deposit Link\n`Form` · completion\n\nRenders both simulated outcomes so you can test success **and** failure.", [], { name: 'c D7', position: [2160, 1780], width: 300, height: 200, color: 6 });
const cD8 = sticky("### D8 · Slot Taken\n`Form` · completion\n\nEnds politely. Nothing is charged.", [], { name: 'c D8', position: [1440, 2500], width: 300, height: 180, color: 3 });
const cE1 = sticky("### E1 · Payment Callback\n`Webhook` GET /pay\n\n**In:** `booking_id`, `outcome`.\n🔧 Swap for the Stripe Trigger.", [], { name: 'c E1', position: [0, 3040], width: 300, height: 190, color: 7 });
const cE2 = sticky("### E2 · Load Booking\n`Data table` · get\n\n⚠️ `alwaysOutputData` — an unknown id must not kill the chain.", [], { name: 'c E2', position: [360, 3040], width: 300, height: 180, color: 6 });
const cE3 = sticky("### E3 · Verify and Re-check Slot\n`Code`\n\n**The race guard.** The slot can go while the card is being entered, so it is checked again here.\n**Out:** `confirmed` · `payment_failed` · `slot_lost_refunded` · `not_found`", [], { name: 'c E3', position: [720, 3040], width: 300, height: 240, color: 5 });
const cE4 = sticky("### E4 · Confirmed?\n`If`\n\nOnly a clean confirm writes money and calendar.", [], { name: 'c E4', position: [1080, 3040], width: 300, height: 170, color: 5 });
const cE5 = sticky("### E5 · Build Payment Row\n`Code`\n\n**Out:** 1 `payments` row, provider `simulated`.", [], { name: 'c E5', position: [1440, 2480], width: 300, height: 170, color: 4 });
const cE6 = sticky("### E6 · Record Payment\n`Data table` · insert", [], { name: 'c E6', position: [1800, 2480], width: 300, height: 160, color: 6 });
const cE7 = sticky("### E7 · Build Confirmed Booking\n`Code`\n\nAll 21 columns, stage `confirmed`, calendar id attached.", [], { name: 'c E7', position: [2160, 2480], width: 300, height: 190, color: 4 });
const cE8 = sticky("### E8 · Confirm Booking\n`Data table` · upsert", [], { name: 'c E8', position: [2520, 2480], width: 300, height: 160, color: 6 });
const cE9 = sticky("### E9 · Build Receipt and SMS\n`Code`\n\n**Out:** 2 `notifications` rows.\n🔧 Swap for Gmail + Twilio.", [], { name: 'c E9', position: [2880, 2480], width: 300, height: 210, color: 4 });
const cE10 = sticky("### E10 · Log Notifications\n`Data table` · insert\n\nFeeds the sent-message counts.", [], { name: 'c E10', position: [3240, 2480], width: 300, height: 170, color: 6 });
const cE11 = sticky("### E11 · Confirm Page\n`Respond` 200\n\nStates deposit paid **and** balance still due.", [], { name: 'c E11', position: [3600, 2480], width: 300, height: 190, color: 6 });
const cE12 = sticky("### E12 · Not Confirmed\n`Respond` 200\n\nNames which of the three failure modes happened.", [], { name: 'c E12', position: [1440, 3200], width: 300, height: 190, color: 3 });
const cF1 = sticky("### F1 · Hourly Sweep\n`Schedule` · every hour", [], { name: 'c F1', position: [0, 3840], width: 300, height: 170, color: 7 });
const cF2 = sticky("### F2 · Load Bookings\n`Data table` · get all", [], { name: 'c F2', position: [360, 3840], width: 300, height: 170, color: 6 });
const cF3 = sticky("### F3 · Find Stalled\n`Code`\n\nStuck stages, older than 24h, not yet chased.\nZero matches is correct — the chain simply stops.", [], { name: 'c F3', position: [720, 3840], width: 300, height: 220, color: 5 });
const cF4 = sticky("### F4 · Build Chase Rows\n`Code`\n\nSMS if we have a phone, otherwise email.", [], { name: 'c F4', position: [1080, 3840], width: 300, height: 190, color: 4 });
const cF5 = sticky("### F5 · Log Chase\n`Data table` · insert", [], { name: 'c F5', position: [1440, 3840], width: 300, height: 160, color: 6 });
const cF6 = sticky("### F6 · Build Chased Bookings\n`Code`\n\nIncrements `chase_count`.", [], { name: 'c F6', position: [1800, 3840], width: 300, height: 180, color: 4 });
const cF7 = sticky("### F7 · Mark Chased\n`Data table` · upsert\n\nWhy nobody gets chased twice.", [], { name: 'c F7', position: [2160, 3840], width: 300, height: 180, color: 6 });
const cG1 = sticky("### G1 · Dashboard Request\n`Webhook` GET /dashboard", [], { name: 'c G1', position: [0, 4540], width: 300, height: 170, color: 7 });
const cG2 = sticky("### G2 · click_events", [], { name: 'c G2', position: [360, 4540], width: 300, height: 150, color: 6 });
const cG3 = sticky("### G3 · bookings", [], { name: 'c G3', position: [720, 4540], width: 300, height: 150, color: 6 });
const cG4 = sticky("### G4 · messages", [], { name: 'c G4', position: [1080, 4540], width: 300, height: 150, color: 6 });
const cG5 = sticky("### G5 · notifications", [], { name: 'c G5', position: [1440, 4540], width: 300, height: 150, color: 6 });
const cG6 = sticky("### G6 · ops_events", [], { name: 'c G6', position: [1800, 4540], width: 300, height: 150, color: 6 });
const cG7 = sticky("### G7 · Render Dashboard\n`Code`\n\nFunnel, post popularity, follow-up list, message volume, failures. Bot clicks excluded from every count.", [], { name: 'c G7', position: [2880, 3820], width: 300, height: 230, color: 5 });
const cG8 = sticky("### G8 · Serve Page\n`Respond` 200 HTML", [], { name: 'c G8', position: [3240, 3820], width: 300, height: 170, color: 6 });
const cG9 = sticky("### G9 · Build Datasets\n`Code`\n\n**Does:** every aggregate, computed once — KPIs, funnel, post popularity, the follow-up list, and a flat event fact table.\n**Out:** 1 item holding all five datasets.\n\nThe single source of truth for all three formats.", [], { name: 'c G9', position: [2160, 4540], width: 300, height: 250, color: 5 });
const cG10 = sticky("### G10 · Which Format?\n`Switch` · reads `?format=`\n\n**json** → G11\n**csv** → G12\n**anything else** → the HTML page\n\nUnknown values fall back to the page rather than erroring.", [], { name: 'c G10', position: [2520, 4540], width: 300, height: 230, color: 5 });
const cG11 = sticky("### G11 · Serve JSON\n`Respond` 200 JSON\n\nAll five datasets in one object. Power BI's **Web** connector expands each list into its own table from this single URL.", [], { name: 'c G11', position: [2880, 4540], width: 300, height: 190, color: 6 });
const cG12 = sticky("### G12 · Build CSV\n`Code` · reads `?dataset=`\n\n`leads` (default) · `events` · `funnel` · `posts`\n\n**Does:** RFC-4180 quoting — commas, quotes and newlines inside a field cannot break the file.", [], { name: 'c G12', position: [2880, 4900], width: 300, height: 230, color: 5 });
const cG13 = sticky("### G13 · Serve CSV\n`Respond` 200 text/csv\n\nSends `content-disposition: attachment`, so a browser downloads it and a CRM importer accepts it.", [], { name: 'c G13', position: [3240, 4900], width: 300, height: 190, color: 6 });

export default workflow('booking-funnel-all-in-one', 'Booking Funnel — All in One (Simulated)')
  .add(errTrig).to(errBuild).to(errWrite)
  .add(clickIn).to(chanCfg).to(clickResolve)
    .to(clickOk.onTrue(clickRow.to(clickLog.to(clickGo))).onFalse(clickBad))
  .add(chatIn).to(botCfg).to(chatNorm).to(chatClick).to(chatContact).to(chatSession)
    .to(chatContactRow).to(chatUpsert).to(chatFaq).to(chatReply).to(chatMsgRows).to(chatLog).to(chatOut)
  .add(bookForm).to(bookCfg).to(bookAvail)
    .to(bookFree.onTrue(bookRow.to(bookSave.to(bookPay))).onFalse(bookTaken))
  .add(payIn).to(payLoad).to(payCheck)
    .to(payOk.onTrue(payRecord.to(paySave.to(payBooking.to(payUpdate.to(payNotify.to(payNotifSave.to(payDone))))))).onFalse(payFail))
  .add(nurTrig).to(nurLoad).to(nurFind).to(nurBuild).to(nurLog).to(nurMark).to(nurSave)
  .add(dashIn).to(dashClicks).to(dashBookings).to(dashMsgs).to(dashNotifs).to(dashOps).to(dashData)
    .to(dashFormat
      .onCase(0, dashJson)
      .onCase(1, dashCsvBuild.to(dashCsvServe))
      .onCase(2, dashRender.to(dashServe)))
  .add(readme).add(banA).add(banB).add(banC).add(banD).add(banE).add(banF).add(banG)
  .add(cA1).add(cA2).add(cA3)
  .add(cB1).add(cB2).add(cB3).add(cB4).add(cB5).add(cB6).add(cB7).add(cB8)
  .add(cC1).add(cC2).add(cC3).add(cC4).add(cC5).add(cC6).add(cC7).add(cC8).add(cC9).add(cC10).add(cC11).add(cC12).add(cC13)
  .add(cD1).add(cD2).add(cD3).add(cD4).add(cD5).add(cD6).add(cD7).add(cD8)
  .add(cE1).add(cE2).add(cE3).add(cE4).add(cE5).add(cE6).add(cE7).add(cE8).add(cE9).add(cE10).add(cE11).add(cE12)
  .add(cF1).add(cF2).add(cF3).add(cF4).add(cF5).add(cF6).add(cF7)
  .add(cG1).add(cG2).add(cG3).add(cG4).add(cG5).add(cG6).add(cG7).add(cG8)
  .add(cG9).add(cG10).add(cG11).add(cG12).add(cG13);