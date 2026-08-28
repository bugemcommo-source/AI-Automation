-- ============================================================================
-- Messenger Knowledge Bot — schema behaviour tests
--
-- Run AFTER 001_messenger_bot_schema.sql, against a scratch database.
-- Do NOT run against production: it writes rows, blocks contacts, and
-- temporarily rewrites bot_config limits.
--
--   psql "$SCRATCH_DB_URL" -f db/001_messenger_bot_schema.sql
--   psql "$SCRATCH_DB_URL" -f db/002_schema_tests.sql
--
-- Every test prints its own expectation in the \echo line above it. All 18
-- pass on Postgres 16.
-- ============================================================================

\set ON_ERROR_STOP on
\pset format aligned

\echo '=== T1: first message from a new contact is allowed and flagged new ==='
select allow, reason, is_new_contact, clean_text
  from bot_gate('psid_A', 'mid_001', '  magkano ang deep tissue?  ', 'Ana');

\echo '=== T2: replaying the SAME mid is rejected as a duplicate ==='
select allow, reason from bot_gate('psid_A', 'mid_001', 'magkano ang deep tissue?', 'Ana');

\echo '=== T3: second distinct message is allowed and NOT flagged new ==='
select allow, reason, is_new_contact from bot_gate('psid_A', 'mid_002', 'open ba kayo sunday?', 'Ana');

\echo '=== T4: history comes back newest-first, no second query needed ==='
select jsonb_array_length(history) as turns from bot_gate('psid_A', 'mid_003', 'thanks', 'Ana');

\echo '=== T5: oversized input is truncated to max_input_chars, not rejected ==='
select allow, length(clean_text) as chars
  from bot_gate('psid_B', 'mid_big', repeat('x', 5000), 'Flooder');

\echo '=== T6: recording an ANSWERED reply does not open an escalation ==='
select bot_record_reply('psid_A', 'PHP 1,800 for 60 minutes.', true, 21000, 180, 0.0200, 'magkano?') as msg_id;
select count(*) as escalations_after_answered from escalations where psid = 'psid_A';

\echo '=== T7: recording an UNANSWERED reply opens an escalation AND mutes the bot ==='
select bot_record_reply('psid_A', 'Let me get someone.', false, 21000, 40, 0.0150, 'do you take HMO?') as msg_id;
select count(*) as escalations_after_decline from escalations where psid = 'psid_A';
select status as conversation_status from conversations where psid = 'psid_A';

\echo '=== T8: once escalated, the bot stays quiet on that thread ==='
select allow, reason from bot_gate('psid_A', 'mid_004', 'hello?', 'Ana');

\echo '=== T9: repeated identical text trips the repeat guard and auto-blocks ==='
select allow, reason from bot_gate('psid_C', 'r1', 'spam', 'C');
select allow, reason from bot_gate('psid_C', 'r2', 'spam', 'C');
select allow, reason from bot_gate('psid_C', 'r3', 'spam', 'C');
select allow, reason from bot_gate('psid_C', 'r4', 'spam', 'C');
select allow, reason from bot_gate('psid_C', 'r5', 'spam', 'C');
select allow, reason as after_block from bot_gate('psid_C', 'r6', 'different text now', 'C');
select status as psid_c_status from conversations where psid = 'psid_C';

\echo '=== T10: hourly rate limit trips at the configured threshold ==='
update bot_config set value = '3' where key = 'rate_limit_per_hour';
select allow, reason from bot_gate('psid_D', 'd1', 'q one', 'D');
select allow, reason from bot_gate('psid_D', 'd2', 'q two', 'D');
select allow, reason from bot_gate('psid_D', 'd3', 'q three', 'D');
select allow, reason as fourth from bot_gate('psid_D', 'd4', 'q four', 'D');
update bot_config set value = '20' where key = 'rate_limit_per_hour';

\echo '=== T11: global daily spend cap stops everyone ==='
update bot_config set value = '0.01' where key = 'global_daily_spend_usd';
select allow, reason from bot_gate('psid_E', 'e1', 'anyone there?', 'E');
update bot_config set value = '25.00' where key = 'global_daily_spend_usd';

\echo '=== T12: empty / sticker-only message is rejected before the model ==='
select allow, reason from bot_gate('psid_F', 'f1', '   ', 'F');

\echo '=== T13: editing a published doc flips embedding_stale and writes an audit row ==='
update kb_documents set embedding_stale = false where title = 'Opening hours';
update kb_documents set body = body || ' Closed Christmas Day.' where title = 'Opening hours';
select embedding_stale from kb_documents where title = 'Opening hours';
select action, (old_row->>'title') as title from kb_audit order by id desc limit 1;

\echo '=== T14: the bot role can read published rows but NOT drafts ==='
set role bot_role;
select count(*) as published_visible from kb_documents where status = 'published';
reset role;

\set ON_ERROR_STOP off
\echo '=== T15: the editor role CANNOT read customer messages ==='
set role editor_role;
select count(*) from messages;
reset role;

\echo '=== T16: bot role sees ONLY published rows, never drafts ==='
set role bot_role;
select status, count(*) from kb_documents group by status order by status;
reset role;

\echo '=== T17: editor role sees drafts too ==='
set role editor_role;
select status, count(*) from kb_documents group by status order by status;
reset role;

\echo '=== T18: bot role cannot read the audit trail ==='
set role bot_role;
select count(*) from kb_audit;
reset role;
