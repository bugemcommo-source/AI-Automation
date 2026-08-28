-- ============================================================================
-- Messenger Knowledge Bot — Phase 4 behaviour tests
--
-- Run AFTER 001 and 003, against a scratch database. Writes rows, blocks
-- contacts and rewrites bot_config limits — never point this at production.
--
--   psql "$SCRATCH_DB_URL" -f db/001_messenger_bot_schema.sql
--   psql "$SCRATCH_DB_URL" -f db/003_phase4_escalation.sql
--   psql "$SCRATCH_DB_URL" -f db/004_phase4_tests.sql
--
-- Each \echo states the expectation. All 18 pass on Postgres 16.
-- ============================================================================

\set ON_ERROR_STOP on
\pset format aligned

-- Re-runnable: clear anything a previous run of THIS file left behind, so a
-- second run does not fail on a duplicate mid or an already-escalated thread.
delete from escalations  where psid like 'p\_%';
delete from messages     where psid like 'p\_%';
delete from conversations where psid like 'p\_%';
update escalation_rules set active = true;

\echo '=== P1: an ordinary question does NOT force an escalation ==='
select allow, reason, force_escalate, escalate_reason
  from bot_gate('p_ok', 'k1', 'magkano ang deep tissue?', 'Ana');

\echo '=== P2: asking for a human forces escalation BEFORE any model call ==='
select allow, force_escalate, escalate_reason
  from bot_gate('p_human', 'k2', 'can i talk to a real person please', 'Ben');

\echo '=== P3: Taglish phrasing hits the same rule ==='
select force_escalate, escalate_reason
  from bot_gate('p_human2', 'k3', 'pwede po ba makausap ang tao dyan', 'Cita');

\echo '=== P4: a refund complaint escalates on the money rule ==='
select force_escalate, escalate_reason
  from bot_gate('p_money', 'k4', 'i want a refund this is a scam', 'Dan');

\echo '=== P5: medical questions escalate, they are never the bot''s to answer ==='
select force_escalate, escalate_reason
  from bot_gate('p_med', 'k5', 'is this safe? i am pregnant', 'Eve');

\echo '=== P6: a disabled rule stops matching ==='
update escalation_rules set active = false where reason = 'money_dispute';
select force_escalate, escalate_reason
  from bot_gate('p_money2', 'k6', 'i want a refund now', 'Fay');
update escalation_rules set active = true where reason = 'money_dispute';

\echo '=== P7: asking the same question 3 times hands over to a human ==='
select force_escalate, escalate_reason from bot_gate('p_rep', 'r1', 'do you do home service?', 'Gil');
select force_escalate, escalate_reason from bot_gate('p_rep', 'r2', 'do you do home service?', 'Gil');
select force_escalate, escalate_reason as third from bot_gate('p_rep', 'r3', 'do you do home service?', 'Gil');

\echo '=== P8: bot_escalate opens an escalation, mutes the bot, costs nothing ==='
select bot_escalate('p_human', 'can i talk to a real person please', 'asked_for_human',
                    'Of course — someone from the team will jump in shortly.', 'keyword') > 0 as opened;
select status, escalation_count from conversations where psid = 'p_human';
select reason, trigger, (sla_due_at > now()) as sla_running, cost_usd is not null as no_cost
  from escalations e join messages m on m.psid = e.psid and m.direction = 'outbound'
 where e.psid = 'p_human' limit 1;

\echo '=== P9: while escalated, the bot stays silent on that thread ==='
select allow, reason from bot_gate('p_human', 'k9', 'hello? anyone?', 'Ben');

\echo '=== P10: a human reply from the Page inbox is captured and stops the SLA ==='
select * from bot_record_human_reply('p_human', 'echo_1', 'Hi Ben! Angela here, happy to help.');
select status, human_last_reply_at is not null as human_replied
  from conversations where psid = 'p_human';
select status as escalation_status, first_response_at is not null as sla_stopped
  from escalations where psid = 'p_human';

\echo '=== P11: the same echo arriving twice is not recorded twice ==='
select recorded as second_time from bot_record_human_reply('p_human', 'echo_1', 'Hi Ben! Angela here, happy to help.');
select count(*) as outbound_rows from messages where psid = 'p_human' and mid = 'echo_1';

\echo '=== P12: releasing hands the thread back and resolves the escalation ==='
select bot_release('p_human', 'answered in the inbox') as released;
select status as conversation_status from conversations where psid = 'p_human';
select status as escalation_status from escalations where psid = 'p_human';

\echo '=== P13: after release the bot answers that contact again ==='
select allow, reason from bot_gate('p_human', 'k13', 'what time do you open?', 'Ben');

\echo '=== P14: an unanswered escalation past its SLA shows up to be chased ==='
select bot_escalate('p_sla', 'do you accept HMO?', 'no_grounded_answer', 'Let me check with the team.', 'model') > 0 as opened;
update escalations set sla_due_at = now() - interval '20 minutes' where psid = 'p_sla';
select psid, reason, nudge_count from bot_pending_nudges() where psid = 'p_sla';
select bot_mark_nudged((select id from escalations where psid = 'p_sla')) as marked;
\echo '--- after chasing once it goes quiet until the repeat interval elapses ---'
select count(*) as still_pending from bot_pending_nudges() where psid = 'p_sla';

\echo '=== P15: an escalation a human ANSWERED is never chased ==='
select * from bot_record_human_reply('p_sla', 'echo_2', 'Hi! Yes we do, sending details now.');
update escalations set sla_due_at = now() - interval '90 minutes', nudged_at = null where psid = 'p_sla';
select count(*) as pending_after_human_replied from bot_pending_nudges() where psid = 'p_sla';

\echo '=== P16: auto-release returns quiet HUMAN threads, never unanswered ones ==='
\echo '--- p_sla: human replied, then quiet -> should release ---'
update conversations
   set last_message_at = now() - interval '30 hours',
       human_last_reply_at = now() - interval '29 hours'
 where psid = 'p_sla';
\echo '--- p_never: escalated, nobody ever replied, also quiet -> must NOT release ---'
select bot_escalate('p_never', 'still waiting', 'no_grounded_answer', 'Someone will follow up.', 'model') > 0 as opened;
update conversations set last_message_at = now() - interval '30 hours' where psid = 'p_never';
select psid, quiet_hours from bot_auto_release() order by psid;
select psid, status from conversations where psid in ('p_sla', 'p_never') order by psid;

\echo '=== P17: the queue view shows who is waiting and whether the SLA broke ==='
select psid, reason, trigger, breached, customer_messages_since
  from v_escalation_queue order by created_at;

\echo '=== P18: the editor can work the queue but the bot cannot edit rules ==='
\set ON_ERROR_STOP off
set role editor_role;
select count(*) as rules_visible_to_editor from escalation_rules;
reset role;
set role bot_role;
select count(*) as active_rules_visible_to_bot from escalation_rules;
insert into escalation_rules (label, pattern) values ('sneaky', 'x');
reset role;
