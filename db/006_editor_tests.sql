-- ============================================================================
-- Messenger Knowledge Bot — Phase 5 behaviour tests
--
-- Run AFTER 001, 003 and 005, against a scratch database.
--
--   psql "$SCRATCH_DB_URL" -f db/001_messenger_bot_schema.sql
--   psql "$SCRATCH_DB_URL" -f db/003_phase4_escalation.sql
--   psql "$SCRATCH_DB_URL" -f db/005_editor_surface.sql
--   psql "$SCRATCH_DB_URL" -f db/006_editor_tests.sql
--
-- The theme is: what happens when a non-developer types the wrong thing.
-- Each \echo states the expectation. All 14 pass on Postgres 16.
-- ============================================================================

\pset format aligned

-- Re-runnable.
delete from escalations   where psid like 'e\_%';
delete from messages      where psid like 'e\_%';
delete from conversations where psid like 'e\_%';
delete from kb_documents  where title like 'TEST %';
delete from escalation_rules where label like 'TEST %';

\echo '=== E1: an unclosed bracket is rejected, with a message an owner can act on ==='
\set ON_ERROR_STOP off
insert into escalation_rules (label, pattern, reason) values ('TEST bad', 'refund(', 'money_dispute');
\set ON_ERROR_STOP on

\echo '=== E2: a pattern matching everything is rejected — it would escalate the whole inbox ==='
\set ON_ERROR_STOP off
insert into escalation_rules (label, pattern, reason) values ('TEST greedy', '.*', 'keyword');
\set ON_ERROR_STOP on

\echo '=== E3: an empty pattern is rejected ==='
\set ON_ERROR_STOP off
insert into escalation_rules (label, pattern, reason) values ('TEST empty', '   ', 'keyword');
\set ON_ERROR_STOP on

\echo '=== E4: a sensible rule is accepted and works ==='
insert into escalation_rules (label, pattern, reason) values ('TEST gcash', 'gcash|gc ash', 'money_dispute');
select force_escalate, escalate_reason from bot_gate('e_ok', 'e1', 'my gcash payment failed', 'Ana');

\echo '=== E5: THE BIG ONE — a bad rule that got in another way cannot take the bot down ==='
\echo '--- inserted with the trigger disabled, simulating a restored backup ---'
alter table escalation_rules disable trigger escalation_rules_validate_trg;
insert into escalation_rules (label, pattern, reason) values ('TEST smuggled', 'refund(', 'money_dispute');
alter table escalation_rules enable trigger escalation_rules_validate_trg;
\echo '--- an unrelated customer sends a completely normal message ---'
select allow, reason, force_escalate from bot_gate('e_victim', 'e2', 'what time do you open?', 'Ben');
\echo '--- and the broken rule switched itself off instead of breaking everyone ---'
select label, active from escalation_rules where label = 'TEST smuggled';

\echo '=== E6: publishing an empty answer is refused ==='
\set ON_ERROR_STOP off
insert into kb_documents (title, body, status) values ('TEST empty answer', '', 'published');
\set ON_ERROR_STOP on

\echo '=== E7: publishing a too-short answer is refused, naming the document ==='
\set ON_ERROR_STOP off
insert into kb_documents (title, body, status) values ('TEST short', 'yes', 'published');
\set ON_ERROR_STOP on

\echo '=== E8: a DRAFT may be half-written — that is what a draft is for ==='
insert into kb_documents (title, body, status) values ('TEST draft', 'tbc', 'draft');
select title, status from kb_documents where title = 'TEST draft';

\echo '=== E9: the bot cannot see that draft ==='
set role bot_role;
select count(*) as draft_visible_to_bot from kb_documents where title = 'TEST draft';
reset role;

\echo '=== E10: publishing it makes the bot see it on the very next message ==='
update kb_documents set body = 'Yes, we offer home service within Metro Manila for an extra PHP 500.', status = 'published' where title = 'TEST draft';
set role bot_role;
select title, status from kb_documents where title = 'TEST draft';
reset role;

\echo '=== E11: the editor views are updatable — NocoDB can write through them ==='
set role editor_role;
insert into kb_editor ("Question or topic", "Answer", "Category", "Status", "Order")
values ('TEST via view', 'We accept cash, GCash and bank transfer for all services.', 'payments', 'published', 50);
update kb_editor set "Answer" = 'We accept cash, GCash, Maya and bank transfer.' where "Question or topic" = 'TEST via view';
select "Question or topic", "Status" from kb_editor where "Question or topic" = 'TEST via view';
reset role;

\echo '=== E12: validation still applies through the view ==='
\set ON_ERROR_STOP off
set role editor_role;
update kb_editor set "Answer" = 'no' where "Question or topic" = 'TEST via view';
reset role;
\set ON_ERROR_STOP on

\echo '=== E13: answering an escalation publishes the doc AND closes the loop ==='
select bot_escalate('e_loop', 'do you do home service?', 'no_grounded_answer', 'Let me check.', 'model') > 0 as escalated;
select bot_escalate('e_loop2', 'do you do home service?', 'no_grounded_answer', 'Let me check.', 'model') > 0 as same_question_from_someone_else;
select document_id is not null as doc_created, escalations_closed, threads_released
  from kb_answer_escalation(
    (select id from escalations where psid = 'e_loop'),
    'TEST home service',
    'Yes, we offer home service within Metro Manila for an extra PHP 500. Book at least a day ahead.',
    'services');
\echo '--- BOTH customers who asked it are closed AND back with the bot, not just the first ---'
select psid, status from conversations where psid in ('e_loop', 'e_loop2') order by psid;
select count(*) as still_open from escalations where question = 'do you do home service?' and status in ('open','in_progress');

\echo '=== E14: the editor sees the queue but still cannot read customer messages ==='
set role editor_role;
select count(*) >= 0 as queue_readable from queue_editor;
\set ON_ERROR_STOP off
select count(*) from messages;
select count(*) from conversations;
\set ON_ERROR_STOP on
reset role;
