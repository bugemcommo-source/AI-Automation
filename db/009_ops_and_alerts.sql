-- ============================================================================
-- Messenger Knowledge Bot — Phase 7: safety nets
--
-- Run AFTER 001, 003, 005 and 007.
--
-- Everything up to here handles the failures it expects. This migration is
-- about the ones it does not.
--
-- Three problems, in rough order of how badly they bite:
--
--   1. SILENCE. An expired Page token or a dropped webhook subscription
--      produces no error anywhere. Messages simply stop arriving, which is
--      indistinguishable from a quiet Tuesday. Nothing in the system notices,
--      because nothing is watching for an absence. This is the failure most
--      likely to run for days before a customer complains.
--
--   2. A REPLY LOGGED BUT NEVER SENT. The workflow recorded the reply before
--      calling Meta, so a failed send still counted as answered. The answer
--      rate looked fine while customers got nothing.
--
--   3. NOBODY TOLD. An unhandled failure died in n8n's execution log. No row,
--      no alert, no trace in the database anyone would think to look at.
--
-- Alert throttling is not a nicety here. An alerting system that fires every
-- ten minutes during an outage gets muted by the people it exists to reach,
-- and then it is worse than nothing.
-- ============================================================================

-- ============================================================================
-- SECTION 1 — CONFIG
-- ============================================================================

insert into bot_config (key, value, description) values
  ('alert_repeat_minutes',      '60',  'Minimum gap between repeats of the SAME alert'),
  ('silence_check_hours',       '6',   'Window with no inbound messages that counts as suspicious'),
  ('silence_min_expected',      '3',   'Historic average for that window below which silence is normal, not alarming'),
  ('undelivered_alert_count',   '3',   'Replies that failed to send within an hour before alerting'),
  ('error_rate_alert_count',    '5',   'Errors within an hour before alerting'),
  ('spend_warn_fraction',       '0.8', 'Fraction of the daily spend cap that triggers a warning')
on conflict (key) do nothing;

-- ============================================================================
-- SECTION 2 — THE EVENT LOG
--
-- One table for everything that went wrong, whoever noticed it: the n8n error
-- trigger, a failed delivery, a watchdog check.
--
-- `fingerprint` is what makes throttling possible. Two occurrences of the same
-- problem share a fingerprint, so "have we already shouted about this?" is a
-- lookup rather than a guess.
-- ============================================================================

create table if not exists ops_events (
  id           bigserial   primary key,
  severity     text        not null default 'error'
                           check (severity in ('info', 'warning', 'error', 'critical')),
  source       text        not null,
  code         text        not null,
  message      text        not null,
  fingerprint  text        not null,
  context      jsonb       not null default '{}'::jsonb,
  occurrences  integer     not null default 1,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  notified_at  timestamptz,
  resolved_at  timestamptz
);

create unique index if not exists ops_events_open_fingerprint_idx
  on ops_events (fingerprint) where resolved_at is null;
create index if not exists ops_events_recent_idx on ops_events (last_seen_at desc);
create index if not exists ops_events_unnotified_idx on ops_events (severity, last_seen_at)
  where resolved_at is null;

-- Records an event, or bumps the count on the open one that matches.
--
-- Collapsing by fingerprint is the whole point: an outage that fires every ten
-- minutes for six hours is ONE row with occurrences = 36, not 36 rows and 36
-- alerts. The alert queue then decides separately whether enough time has
-- passed to shout again.
create or replace function bot_log_event(
  p_source   text,
  p_code     text,
  p_message  text,
  p_severity text  default 'error',
  p_context  jsonb default '{}'::jsonb
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fp text;
  v_id bigint;
begin
  -- Source + code, not the message: two failures of the same kind should
  -- collapse even when their messages differ by a timestamp or an id.
  v_fp := p_source || ':' || p_code;

  insert into ops_events (severity, source, code, message, fingerprint, context)
  values (coalesce(p_severity, 'error'), p_source, p_code,
          left(coalesce(p_message, ''), 2000), v_fp, coalesce(p_context, '{}'::jsonb))
  on conflict (fingerprint) where resolved_at is null
  do update set
    occurrences  = ops_events.occurrences + 1,
    last_seen_at = now(),
    message      = left(coalesce(excluded.message, ops_events.message), 2000),
    context      = excluded.context,
    -- An escalating problem should be able to raise its own severity, but a
    -- single info-level recurrence must not quietly downgrade a critical one.
    severity     = case
                     when excluded.severity = 'critical' then 'critical'
                     when ops_events.severity = 'critical' then 'critical'
                     when excluded.severity = 'error' or ops_events.severity = 'error' then 'error'
                     else excluded.severity
                   end
  returning id into v_id;

  return v_id;
end;
$$;

-- Marks a problem fixed. The partial unique index is on unresolved rows only,
-- so the next occurrence opens a fresh row with its own first_seen_at rather
-- than reviving a stale one — which keeps "how long was this broken?" honest.
create or replace function bot_resolve_event(p_source text, p_code text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer := 0;
begin
  update ops_events
     set resolved_at = now()
   where fingerprint = p_source || ':' || p_code
     and resolved_at is null;
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

-- ============================================================================
-- SECTION 3 — DID THE CUSTOMER ACTUALLY GET IT?
--
-- The workflow logged the reply before calling Meta, so an expired token still
-- produced answered = true. The answer rate looked healthy while customers
-- received nothing — the worst kind of failure, because the metric you would
-- check to spot it was the metric that was lying.
--
-- Now a reply is written as undelivered and only marked delivered once Meta
-- has accepted it.
-- ============================================================================

alter table messages
  add column if not exists delivered      boolean,
  add column if not exists delivery_error text,
  add column if not exists delivered_at   timestamptz;

create index if not exists messages_undelivered_idx on messages (created_at desc)
  where direction = 'outbound' and delivered is false;

create or replace function bot_mark_delivered(
  p_message_id bigint,
  p_ok         boolean,
  p_error      text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update messages
     set delivered      = p_ok,
         delivered_at   = case when p_ok then now() else null end,
         delivery_error = case when p_ok then null else left(coalesce(p_error, 'send failed'), 500) end
   where messages.id = p_message_id;

  if not p_ok then
    perform bot_log_event(
      'messenger', 'send_failed',
      'A reply could not be delivered to Messenger. Usually an expired Page Access Token or a revoked permission.',
      'critical',
      jsonb_build_object('message_id', p_message_id, 'error', left(coalesce(p_error, ''), 500))
    );
  end if;

  return true;
end;
$$;

-- The answer rate, corrected. v_answer_rate counts what the bot decided;
-- this counts what the customer actually received. When these two diverge,
-- delivery is broken, not the model.
create or replace view v_delivery_health as
select
  date_trunc('day', created_at)::date            as day,
  count(*)                                       as replies,
  count(*) filter (where delivered is true)      as delivered,
  count(*) filter (where delivered is false)     as failed,
  count(*) filter (where delivered is null)      as unknown,
  round(100.0 * count(*) filter (where delivered is true)
        / nullif(count(*) filter (where delivered is not null), 0), 1) as delivered_pct
from messages
where direction = 'outbound'
group by 1
order by 1 desc;

-- ============================================================================
-- SECTION 4 — WATCHING FOR AN ABSENCE
--
-- The hardest failure to detect, because it looks exactly like success: no
-- errors, no failed requests, just nothing arriving.
--
-- Naive "alert if quiet for 6 hours" pages you every single night. So the
-- check is comparative: alert only if this window is silent AND the same
-- window in previous weeks normally carried traffic. A genuinely quiet
-- business never gets woken up, and a Page whose token expired does.
-- ============================================================================

create or replace function bot_check_silence()
returns table (
  suspicious     boolean,
  quiet_hours    integer,
  expected_msgs  numeric,
  last_inbound_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hours    integer;
  v_min_exp  integer;
  v_last     timestamptz;
  v_recent   integer;
  v_expected numeric;
begin
  select (value)::integer into v_hours   from bot_config where key = 'silence_check_hours';
  select (value)::integer into v_min_exp from bot_config where key = 'silence_min_expected';
  v_hours   := coalesce(v_hours, 6);
  v_min_exp := coalesce(v_min_exp, 3);

  select max(created_at) into v_last
    from messages where direction = 'inbound';

  select count(*) into v_recent
    from messages
   where direction = 'inbound'
     and created_at > now() - make_interval(hours => v_hours);

  -- The same clock window on the same weekday, over the previous four weeks.
  -- Comparing like with like is what stops a Sunday-closed business from
  -- being paged every Sunday.
  select coalesce(avg(cnt), 0) into v_expected
    from (
      select count(*) as cnt
        from generate_series(1, 4) wk
        left join messages m
          on m.direction = 'inbound'
         and m.created_at > now() - make_interval(days => 7 * wk::integer)
                                  - make_interval(hours => v_hours)
         and m.created_at <= now() - make_interval(days => 7 * wk::integer)
       group by wk
    ) weekly;

  return query select
    (v_recent = 0 and v_expected >= v_min_exp),
    v_hours,
    round(v_expected, 1),
    v_last;
end;
$$;

-- ============================================================================
-- SECTION 5 — ONE HEALTH VERDICT
--
-- Everything a watchdog needs in a single row, so the scheduled flow makes one
-- query rather than six and cannot check half of them and stop.
-- ============================================================================

create or replace function bot_health()
returns table (
  check_name text,
  status     text,
  detail     text,
  context    jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sil        record;
  v_undelivered integer;
  v_undel_limit integer;
  v_errors     integer;
  v_err_limit  integer;
  v_spend      numeric;
  v_cap        numeric;
  v_warn_at    numeric;
  v_stale      integer;
  v_models     integer;
  v_enabled    boolean;
  v_open_esc   integer;
begin
  select (value)::integer into v_undel_limit from bot_config where key = 'undelivered_alert_count';
  select (value)::integer into v_err_limit   from bot_config where key = 'error_rate_alert_count';
  select (value)::numeric into v_cap         from bot_config where key = 'global_daily_spend_usd';
  select (value)::numeric into v_warn_at     from bot_config where key = 'spend_warn_fraction';
  select (value)::boolean into v_enabled     from bot_config where key = 'retrieval_enabled';

  -- 1. Is anything arriving at all?
  select * into v_sil from bot_check_silence();
  check_name := 'inbound_traffic';
  if v_sil.suspicious then
    status := 'critical';
    detail := 'No messages for ' || v_sil.quiet_hours || 'h, but this window normally carries about '
              || v_sil.expected_msgs || '. Check the Page Access Token and that the webhook is still subscribed to messages.';
  else
    status := 'ok';
    detail := 'Last inbound ' || coalesce(to_char(v_sil.last_inbound_at, 'YYYY-MM-DD HH24:MI'), 'never');
  end if;
  context := jsonb_build_object('quiet_hours', v_sil.quiet_hours,
                                'expected', v_sil.expected_msgs,
                                'last_inbound_at', v_sil.last_inbound_at);
  return next;

  -- 2. Are replies reaching customers?
  select count(*) into v_undelivered
    from messages m
   where m.direction = 'outbound' and m.delivered is false
     and m.created_at > now() - interval '1 hour';
  check_name := 'delivery';
  status := case when v_undelivered >= coalesce(v_undel_limit, 3) then 'critical' else 'ok' end;
  detail := v_undelivered || ' replies failed to send in the last hour';
  context := jsonb_build_object('undelivered', v_undelivered);
  return next;

  -- 3. Is anything throwing?
  select coalesce(sum(e.occurrences), 0) into v_errors
    from ops_events e
   where e.severity in ('error', 'critical')
     and e.resolved_at is null
     and e.last_seen_at > now() - interval '1 hour';
  check_name := 'errors';
  status := case when v_errors >= coalesce(v_err_limit, 5) then 'warning' else 'ok' end;
  detail := v_errors || ' errors in the last hour';
  context := jsonb_build_object('errors', v_errors);
  return next;

  -- 4. Are we about to hit the spend cap and mute the whole bot?
  select coalesce(sum(m.cost_usd), 0) into v_spend
    from messages m where m.created_at >= date_trunc('day', now() at time zone 'utc');
  check_name := 'spend';
  if v_spend >= v_cap then
    status := 'critical';
    detail := 'Daily spend cap reached. The bot is refusing new messages until UTC midnight.';
  elsif v_spend >= v_cap * coalesce(v_warn_at, 0.8) then
    status := 'warning';
    detail := 'Spend at ' || round(v_spend, 2) || ' of a ' || v_cap || ' cap';
  else
    status := 'ok';
    detail := 'Spend ' || round(v_spend, 2) || ' of ' || v_cap;
  end if;
  context := jsonb_build_object('spend_usd', round(v_spend, 4), 'cap_usd', v_cap);
  return next;

  -- 5. Is the index trustworthy? Only matters when retrieval is on.
  -- Table-qualified: this function has OUT parameters named `status`,
  -- `detail`, `check_name` and `context`, which shadow the column names.
  select count(*) into v_stale
    from kb_documents d
   where d.status = 'published' and d.embedding_stale;
  select count(distinct c.embedding_model) into v_models
    from kb_chunks c where c.embedding_model is not null;
  check_name := 'retrieval';
  if not coalesce(v_enabled, false) then
    status := 'ok';
    detail := 'Retrieval is off; the whole knowledge base is sent each message';
  elsif v_models > 1 then
    status := 'critical';
    detail := v_models || ' embedding models in one index. Results are meaningless until the re-index sweep finishes.';
  elsif v_stale > 0 then
    status := 'warning';
    detail := v_stale || ' published documents are waiting to be indexed';
  else
    status := 'ok';
    detail := 'Index current';
  end if;
  context := jsonb_build_object('stale_docs', v_stale, 'distinct_models', v_models, 'enabled', coalesce(v_enabled, false));
  return next;

  -- 6. Is anyone answering the humans?
  select count(*) into v_open_esc
    from escalations e
   where e.status = 'open' and e.first_response_at is null
     and e.created_at < now() - interval '2 hours';
  check_name := 'escalation_backlog';
  status := case when v_open_esc > 0 then 'warning' else 'ok' end;
  detail := v_open_esc || ' customers have been waiting over two hours for a person';
  context := jsonb_build_object('waiting', v_open_esc);
  return next;
end;
$$;

-- ============================================================================
-- SECTION 6 — THE ALERT QUEUE
--
-- Separates "something is wrong" from "tell someone", because those have
-- different rhythms. An outage stays wrong continuously; it should be
-- announced once, then again only after the repeat interval.
-- ============================================================================

create or replace function bot_pending_alerts()
returns table (
  event_id    bigint,
  severity    text,
  source      text,
  code        text,
  message     text,
  occurrences integer,
  first_seen_at timestamptz,
  context     jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_repeat integer;
begin
  select (value)::integer into v_repeat from bot_config where key = 'alert_repeat_minutes';
  v_repeat := coalesce(v_repeat, 60);

  return query
  select e.id, e.severity, e.source, e.code, e.message, e.occurrences, e.first_seen_at, e.context
    from ops_events e
   where e.resolved_at is null
     and e.severity in ('error', 'critical')
     and (e.notified_at is null
          or e.notified_at < now() - make_interval(mins => v_repeat))
   order by
     case e.severity when 'critical' then 0 else 1 end,
     e.first_seen_at asc
   limit 10;
end;
$$;

create or replace function bot_mark_alerted(p_event_id bigint)
returns boolean
language sql
security definer
set search_path = public
as $$
  update ops_events set notified_at = now() where id = p_event_id returning true;
$$;

-- Runs the health checks and turns anything failing into a logged event, so
-- the watchdog flow is a single call rather than six conditionals it could
-- get subtly wrong. Auto-resolves a check that has recovered, which is what
-- lets the next occurrence be reported as new rather than as an ancient
-- unresolved row.
create or replace function bot_run_health_checks()
returns table (check_name text, status text, detail text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
begin
  for v_row in select * from bot_health() loop
    if v_row.status in ('warning', 'critical') then
      perform bot_log_event('health', v_row.check_name, v_row.detail, v_row.status, v_row.context);
    else
      perform bot_resolve_event('health', v_row.check_name);
    end if;
    check_name := v_row.check_name;
    status     := v_row.status;
    detail     := v_row.detail;
    return next;
  end loop;
end;
$$;

-- ============================================================================
-- SECTION 7 — GRANTS AND RLS
-- ============================================================================

grant execute on function bot_log_event(text, text, text, text, jsonb)  to bot_role;
grant execute on function bot_resolve_event(text, text)                 to bot_role;
grant execute on function bot_mark_delivered(bigint, boolean, text)     to bot_role;
grant execute on function bot_check_silence()                           to bot_role;
grant execute on function bot_health()                                  to bot_role;
grant execute on function bot_run_health_checks()                       to bot_role;
grant execute on function bot_pending_alerts()                          to bot_role;
grant execute on function bot_mark_alerted(bigint)                      to bot_role;
grant select on v_delivery_health to bot_role;

alter table ops_events enable row level security;

drop policy if exists ops_events_bot_read on ops_events;
create policy ops_events_bot_read on ops_events
  for select to bot_role using (true);

-- The knowledge editor has no business reading the error log — it carries
-- message ids and failure context from customer conversations.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on ops_events from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on ops_events from authenticated;
  end if;
end
$$;
