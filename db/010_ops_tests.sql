-- ============================================================================
-- Messenger Knowledge Bot — Phase 7 behaviour tests
--
-- Run AFTER 001, 003, 005, 007 and 009, against a scratch database.
--
-- The theme is: does the system notice when it is broken, and does it say so
-- exactly once rather than every ten minutes?
--
-- Each \echo states the expectation. All 16 pass on Postgres 16 + pgvector.
-- ============================================================================

\pset format aligned

-- Re-runnable.
delete from ops_events;
delete from escalations   where psid like 'o\_%';
delete from messages      where psid like 'o\_%';
delete from conversations where psid like 'o\_%';

\echo '=== O1: an event is logged ==='
select bot_log_event('anthropic', 'api_error', 'Claude returned 529 overloaded', 'error',
                     '{"status":529}'::jsonb) > 0 as logged;
select source, code, severity, occurrences from ops_events where source = 'anthropic';

\echo '=== O2: the SAME failure again collapses into one row, it does not pile up ==='
select bot_log_event('anthropic', 'api_error', 'Claude returned 529 overloaded', 'error') > 0 as logged;
select bot_log_event('anthropic', 'api_error', 'Claude returned 529 overloaded', 'error') > 0 as logged;
select count(*) as rows, max(occurrences) as occurrences from ops_events where source = 'anthropic';
\echo '--- an outage firing every 10 min for 6h is ONE row, not 36 alerts ---'

\echo '=== O3: severity escalates but never silently downgrades ==='
select bot_log_event('anthropic', 'api_error', 'now much worse', 'critical') > 0 as logged;
select severity as after_critical from ops_events where source = 'anthropic';
select bot_log_event('anthropic', 'api_error', 'a minor blip', 'info') > 0 as logged;
select severity as still_critical from ops_events where source = 'anthropic';

\echo '=== O4: an unresolved event appears in the alert queue exactly once ==='
select count(*) as queued from bot_pending_alerts() where source = 'anthropic';
select bot_mark_alerted((select id from ops_events where source = 'anthropic')) as marked;
select count(*) as queued_after_alerting from bot_pending_alerts() where source = 'anthropic';
\echo '--- alerting that repeats every cycle gets muted by the people it is for ---'

\echo '=== O5: after the repeat interval it is allowed to shout again ==='
update ops_events set notified_at = now() - interval '2 hours' where source = 'anthropic';
select count(*) as queued_again from bot_pending_alerts() where source = 'anthropic';

\echo '=== O6: resolving closes it, and the NEXT occurrence opens a fresh row ==='
select bot_resolve_event('anthropic', 'api_error') as resolved_rows;
select count(*) as still_queued from bot_pending_alerts() where source = 'anthropic';
select bot_log_event('anthropic', 'api_error', 'it is back', 'error') > 0 as logged_again;
select count(*) as total_rows, sum(case when resolved_at is null then 1 else 0 end) as open_rows
  from ops_events where source = 'anthropic';
\echo '--- a fresh row means "how long has this been broken?" stays honest ---'

\echo '=== O7: info-level noise never reaches the alert queue ==='
select bot_log_event('ingestion', 'skipped', 'nothing to index', 'info') > 0 as logged;
select count(*) as info_alerts from bot_pending_alerts() where source = 'ingestion';

\echo '=== O8: a delivered reply is marked delivered ==='
insert into conversations (psid) values ('o_deliver');
insert into messages (psid, direction, body, answered) values ('o_deliver', 'outbound', 'PHP 1,800.', true);
select bot_mark_delivered((select id from messages where psid = 'o_deliver'), true) as marked;
select delivered, delivered_at is not null as stamped, delivery_error
  from messages where psid = 'o_deliver';

\echo '=== O9: THE BUG THIS FIXES — a failed send is not counted as answered ==='
insert into conversations (psid) values ('o_fail');
insert into messages (psid, direction, body, answered) values ('o_fail', 'outbound', 'never arrived', true);
select bot_mark_delivered((select id from messages where psid = 'o_fail'), false,
                          'Error validating access token: Session has expired') as marked;
select delivered, left(delivery_error, 40) as error from messages where psid = 'o_fail';
\echo '--- and it raises a CRITICAL event by itself, no separate wiring needed ---'
select severity, code, left(message, 50) as message from ops_events where source = 'messenger';

\echo '=== O10: the corrected answer rate separates "bot decided" from "customer got" ==='
select replies, delivered, failed, delivered_pct from v_delivery_health;
\echo '--- when v_answer_rate and this diverge, delivery is broken, not the model ---'

\echo '=== O11: silence is NOT suspicious for a business that is normally quiet ==='
select suspicious, quiet_hours, expected_msgs from bot_check_silence();
\echo '--- no history means no expectation; a new Page must not page anyone ---'

\echo '=== O12: silence IS suspicious when that window normally carries traffic ==='
\echo '--- seed the same clock window on the same weekday for the last 4 weeks ---'
insert into conversations (psid) values ('o_hist') on conflict do nothing;
insert into messages (psid, direction, body, created_at)
select 'o_hist', 'inbound', 'historic message ' || g,
       now() - make_interval(days => 7 * wk) - make_interval(hours => 1)
  from generate_series(1, 4) wk, generate_series(1, 5) g;
select suspicious, quiet_hours, expected_msgs from bot_check_silence();
\echo '--- an expired token produces exactly this: no errors, just nothing arriving ---'

\echo '=== O13: traffic right now clears the alarm ==='
insert into messages (psid, direction, body) values ('o_hist', 'inbound', 'a customer just messaged');
select suspicious from bot_check_silence();

\echo '=== O14: the health check returns a verdict for every subsystem ==='
select check_name, status from bot_health() order by check_name;

\echo '=== O15: running the checks turns failures into events, and recoveries close them ==='
\echo '--- record real spend today, then set a cap below it ---'
insert into conversations (psid) values ('o_spend') on conflict do nothing;
insert into messages (psid, direction, body, cost_usd) values ('o_spend', 'outbound', 'costly', 0.50);
update bot_config set value = '0.10' where key = 'global_daily_spend_usd';
select check_name, status from bot_run_health_checks() where check_name = 'spend';
select code, severity from ops_events where source = 'health' and code = 'spend';
\echo '--- put the cap back; the next run should auto-resolve it ---'
update bot_config set value = '25.00' where key = 'global_daily_spend_usd';
select check_name, status from bot_run_health_checks() where check_name = 'spend';
select code, resolved_at is not null as auto_resolved
  from ops_events where source = 'health' and code = 'spend';

\echo '=== O16: the editor cannot read the error log ==='
\set ON_ERROR_STOP off
set role editor_role;
select count(*) from ops_events;
reset role;
\set ON_ERROR_STOP on
