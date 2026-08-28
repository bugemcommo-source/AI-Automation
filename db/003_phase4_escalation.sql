-- ============================================================================
-- Messenger Knowledge Bot — Phase 4: escalation and the human path
--
-- Run AFTER 001_messenger_bot_schema.sql.
--
-- Phase 3 could escalate, but only on the model's own judgement, and nothing
-- could ever hand a thread back. This migration closes both gaps:
--
--   * Deterministic triggers that fire BEFORE the model. "Talk to a human"
--     should never cost an API call, and should never depend on the model
--     agreeing that it counts.
--   * A release path, driven by a signal already arriving on the webhook —
--     when a human answers from the Page inbox, Meta echoes it back to us.
--   * An SLA, so an escalation nobody picks up gets chased instead of
--     sitting silently in a table.
-- ============================================================================

-- ============================================================================
-- SECTION 1 — CONFIG
-- ============================================================================

insert into bot_config (key, value, description) values
  ('escalation_sla_minutes',        '15',  'Minutes before an unanswered escalation is chased'),
  ('escalation_nudge_every_minutes','60',  'Minutes between repeat chases on the same escalation'),
  ('auto_release_hours',            '24',  'Hours of quiet after a human reply before the bot resumes the thread'),
  ('repeat_question_limit',         '2',   'Identical-ish questions in a row before handing to a human')
on conflict (key) do nothing;

-- ============================================================================
-- SECTION 2 — ESCALATION RULES
--
-- Editable by the knowledge editor, exactly like kb_documents. When the owner
-- notices the bot fumbling anything about "gcash refund", they add a row —
-- they do not file a ticket with a developer.
--
-- `pattern` is a case-insensitive POSIX regex matched against the customer's
-- message. Inbound text is already capped at 1,000 characters by bot_gate, so
-- a clumsy pattern cannot become a runaway scan.
-- ============================================================================

create table if not exists escalation_rules (
  id          uuid        primary key default gen_random_uuid(),
  label       text        not null,
  pattern     text        not null,
  reason      text        not null default 'keyword',
  active      boolean     not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists escalation_rules_active_idx on escalation_rules (label)
  where active;

insert into escalation_rules (label, pattern, reason) values
  ('Asks for a human',   '(talk|speak|chat).{0,15}(human|person|staff|agent|someone)|makausap|kausapin|kausap.{0,10}(tao|staff)|real person|customer service|human agent', 'asked_for_human'),
  ('Money dispute',      'refund|reklamo|complain|dispute|chargeback|scam|overcharge|double charge',                     'money_dispute'),
  ('Cancellation',       'cancel|reschedul|move my booking|palitan.{0,12}(schedule|oras)',                              'cancellation'),
  ('Existing booking',   'my booking|my appointment|na-book|nabook ko|booking ko',                                      'existing_booking'),
  ('Medical or safety',  'allerg|pregnan|buntis|injur|hospital|doctor|medical condition|surgery',                        'medical_or_safety'),
  ('Legal or press',     'lawyer|attorney|sue |legal action|journalist|reporter',                                        'legal_or_press')
on conflict do nothing;

-- ============================================================================
-- SECTION 3 — COLUMNS THE LIFECYCLE NEEDS
-- ============================================================================

alter table escalations
  add column if not exists trigger          text        not null default 'model',
  add column if not exists assigned_to      text,
  add column if not exists first_response_at timestamptz,
  add column if not exists sla_due_at       timestamptz,
  add column if not exists nudged_at        timestamptz,
  add column if not exists nudge_count      integer     not null default 0;

alter table conversations
  add column if not exists escalated_at        timestamptz,
  add column if not exists escalation_count    integer     not null default 0,
  add column if not exists human_last_reply_at timestamptz;

-- Open escalations past their SLA, cheapest possible index for the sweep.
create index if not exists escalations_sla_idx on escalations (sla_due_at)
  where status = 'open' and first_response_at is null;

-- ============================================================================
-- SECTION 4 — bot_gate, VERSION 2
--
-- Same contract as before plus two columns: force_escalate and escalate_reason.
--
-- Why the keyword check lives HERE rather than in the prompt: a customer
-- typing "I want to talk to a human" should reach a human whether or not the
-- model agrees, and should not cost two cents to process. Deterministic rules
-- are both cheaper and more trustworthy than model judgement for the cases
-- where getting it wrong actually matters.
--
-- The return type changes, so the old function has to be dropped rather than
-- replaced.
-- ============================================================================

drop function if exists bot_gate(text, text, text, text);

create function bot_gate(
  p_psid text,
  p_mid  text,
  p_text text,
  p_name text default null
)
returns table (
  allow           boolean,
  reason          text,
  is_new_contact  boolean,
  status          text,
  clean_text      text,
  history         jsonb,
  force_escalate  boolean,
  escalate_reason text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cfg          jsonb;
  v_max_chars    integer;
  v_clean        text;
  v_is_new       boolean := false;
  v_status       text;
  v_inserted     boolean := false;
  v_rows         integer := 0;
  v_hour_count   integer;
  v_day_count    integer;
  v_repeat_count integer;
  v_global_count integer;
  v_global_spend numeric;
  v_reason       text := 'ok';
  v_esc_reason   text := '';
  v_similar      integer;
begin
  select jsonb_object_agg(key, value) into v_cfg from bot_config;
  v_max_chars := (v_cfg ->> 'max_input_chars')::integer;
  v_clean := left(btrim(coalesce(p_text, '')), v_max_chars);

  insert into conversations (psid, display_name, last_message_at, message_count)
  values (p_psid, p_name, now(), 1)
  on conflict (psid) do update
    set last_message_at = now(),
        message_count   = conversations.message_count + 1,
        display_name    = coalesce(conversations.display_name, excluded.display_name)
  returning (xmax = 0) into v_is_new;

  select conversations.status into v_status from conversations where conversations.psid = p_psid;

  if p_mid is not null then
    insert into messages (psid, direction, mid, body)
    values (p_psid, 'inbound', p_mid, v_clean)
    on conflict (mid) where mid is not null do nothing;
    get diagnostics v_rows = row_count;
    v_inserted := (v_rows > 0);
  else
    insert into messages (psid, direction, mid, body)
    values (p_psid, 'inbound', null, v_clean);
    v_inserted := true;
  end if;

  if not v_inserted then
    v_reason := 'duplicate_mid';
  elsif v_status = 'blocked' then
    v_reason := 'blocked';
  elsif v_status in ('escalated', 'human') then
    v_reason := 'human_handling';
  elsif v_clean = '' then
    v_reason := 'empty_message';
  else
    select count(*) into v_hour_count
      from messages
     where messages.psid = p_psid and direction = 'inbound'
       and created_at > now() - interval '1 hour';

    select count(*) into v_day_count
      from messages
     where messages.psid = p_psid and direction = 'inbound'
       and created_at > now() - interval '1 day';

    select count(*) into v_repeat_count
      from messages
     where messages.psid = p_psid and direction = 'inbound'
       and body = v_clean
       and created_at > now() - interval '10 minutes';

    select count(*), coalesce(sum(cost_usd), 0)
      into v_global_count, v_global_spend
      from messages
     where created_at >= date_trunc('day', now() at time zone 'utc');

    if v_hour_count > (v_cfg ->> 'rate_limit_per_hour')::integer then
      v_reason := 'rate_limit_hour';
    elsif v_day_count > (v_cfg ->> 'rate_limit_per_day')::integer then
      v_reason := 'rate_limit_day';
    elsif v_repeat_count > (v_cfg ->> 'repeat_text_limit')::integer then
      v_reason := 'repeated_text';
    elsif v_global_count > (v_cfg ->> 'global_daily_message_cap')::integer then
      v_reason := 'global_message_cap';
    elsif v_global_spend > (v_cfg ->> 'global_daily_spend_usd')::numeric then
      v_reason := 'global_spend_cap';
    end if;
  end if;

  if v_reason in ('rate_limit_day', 'repeated_text') then
    update conversations set status = 'blocked'
     where conversations.psid = p_psid and conversations.status = 'bot';
  end if;

  -- ---- Escalation triggers, only for messages we are actually going to act on
  if v_reason = 'ok' then
    -- 1. An editable rule matched.
    select r.reason into v_esc_reason
      from escalation_rules r
     where r.active and v_clean ~* r.pattern
     limit 1;

    -- 2. The customer is asking the same thing again. Rephrasing means the
    --    answer is not landing, and trying a third time rarely helps.
    --    repeat_question_limit (2) is deliberately below repeat_text_limit (4)
    --    so a frustrated customer reaches a human before they are ever
    --    treated as a flooder and blocked.
    if v_esc_reason is null then
      select count(*) into v_similar
        from messages m
       where m.psid = p_psid
         and m.direction = 'inbound'
         and m.created_at > now() - interval '30 minutes'
         and m.body = v_clean;
      if v_similar > (v_cfg ->> 'repeat_question_limit')::integer then
        v_esc_reason := 'repeated_question';
      end if;
    end if;
  end if;

  return query
  select
    (v_reason = 'ok'),
    v_reason,
    coalesce(v_is_new, false),
    coalesce(v_status, 'bot'),
    v_clean,
    coalesce(
      (select jsonb_agg(t) from (
         select m.direction, m.body, m.created_at
           from messages m
          where m.psid = p_psid
          order by m.created_at desc
          limit 10
       ) t),
      '[]'::jsonb
    ),
    (v_esc_reason is not null and v_esc_reason <> ''),
    coalesce(v_esc_reason, '');
end;
$$;

-- ============================================================================
-- SECTION 5 — ESCALATE WITHOUT A MODEL CALL
--
-- Used when bot_gate returned force_escalate. Writes the acknowledgement the
-- customer will receive, opens the escalation with its SLA clock started, and
-- mutes the bot — the same end state the model path reaches, at zero token
-- cost.
-- ============================================================================

create or replace function bot_escalate(
  p_psid     text,
  p_question text,
  p_reason   text,
  p_reply    text,
  p_trigger  text default 'keyword'
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id      bigint;
  v_sla_min integer;
begin
  select (value)::integer into v_sla_min from bot_config where key = 'escalation_sla_minutes';

  -- In the live flow bot_gate has already created this row. Not assuming so
  -- keeps the function safe to call from a queue UI or a manual escalation,
  -- where the foreign key would otherwise be a hard crash.
  insert into conversations (psid) values (p_psid)
  on conflict (psid) do nothing;

  insert into messages (psid, direction, body, answered, escalated, cost_usd)
  values (p_psid, 'outbound', p_reply, false, true, 0);

  insert into escalations (psid, question, reason, trigger, sla_due_at, transcript)
  values (
    p_psid,
    p_question,
    p_reason,
    p_trigger,
    now() + make_interval(mins => coalesce(v_sla_min, 15)),
    coalesce(
      (select jsonb_agg(t) from (
         select m.direction, m.body, m.created_at
           from messages m
          where m.psid = p_psid
          order by m.created_at desc
          limit 10
       ) t),
      '[]'::jsonb
    )
  )
  returning id into v_id;

  update conversations
     set status            = 'escalated',
         escalated_at      = now(),
         escalation_count  = conversations.escalation_count + 1,
         last_bot_reply_at = now()
   where conversations.psid = p_psid;

  return v_id;
end;
$$;

-- ============================================================================
-- SECTION 6 — bot_record_reply, VERSION 2
--
-- Same as Phase 3, but the escalation it opens now carries an SLA clock and a
-- trigger, and the conversation records when it was escalated.
-- ============================================================================

create or replace function bot_record_reply(
  p_psid       text,
  p_body       text,
  p_answered   boolean,
  p_tokens_in  integer default null,
  p_tokens_out integer default null,
  p_cost_usd   numeric default 0,
  p_question   text    default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id      bigint;
  v_sla_min integer;
begin
  insert into messages (psid, direction, body, answered, escalated,
                        tokens_in, tokens_out, cost_usd)
  values (p_psid, 'outbound', p_body, p_answered, not p_answered,
          p_tokens_in, p_tokens_out, coalesce(p_cost_usd, 0))
  returning id into v_id;

  update conversations set last_bot_reply_at = now()
   where conversations.psid = p_psid;

  if not p_answered then
    select (value)::integer into v_sla_min from bot_config where key = 'escalation_sla_minutes';

    insert into escalations (psid, question, reason, trigger, sla_due_at, transcript)
    values (
      p_psid,
      coalesce(p_question, '(not captured)'),
      'no_grounded_answer',
      'model',
      now() + make_interval(mins => coalesce(v_sla_min, 15)),
      coalesce(
        (select jsonb_agg(t) from (
           select m.direction, m.body, m.created_at
             from messages m
            where m.psid = p_psid
            order by m.created_at desc
            limit 10
         ) t),
        '[]'::jsonb
      )
    );

    update conversations
       set status           = 'escalated',
           escalated_at     = coalesce(conversations.escalated_at, now()),
           escalation_count = conversations.escalation_count + 1
     where conversations.psid = p_psid and conversations.status = 'bot';
  end if;

  return v_id;
end;
$$;

-- ============================================================================
-- SECTION 7 — THE HUMAN REPLIED
--
-- This is the piece that makes handoff work without building any UI.
--
-- When someone answers from the Facebook Page inbox, Meta echoes that message
-- back to our webhook with app_id 263902037430900 (the Page inbox app). Phase 3
-- threw every echo away. Here, an echo carrying that app id is treated as what
-- it actually is: proof that a human has picked the conversation up.
--
-- Meta also applies the HUMAN_AGENT tag automatically to inbox replies, which
-- extends the messaging window from 24 hours to 7 days. So the human simply
-- replies where they always would, and both the handoff and the policy
-- compliance fall out for free.
-- ============================================================================

create or replace function bot_record_human_reply(
  p_psid text,
  p_mid  text,
  p_body text
)
returns table (recorded boolean, escalation_id bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer := 0;
  v_esc  bigint;
begin
  -- Echoes are retried like any other webhook, so dedupe on mid first.
  insert into messages (psid, direction, mid, body, answered, cost_usd)
  values (p_psid, 'outbound', p_mid, left(coalesce(p_body, ''), 4000), true, 0)
  on conflict (mid) where mid is not null do nothing;
  get diagnostics v_rows = row_count;

  if v_rows = 0 then
    return query select false, null::bigint;
    return;
  end if;

  update conversations
     set status              = 'human',
         human_last_reply_at = now()
   where conversations.psid = p_psid;

  -- Stop the SLA clock on the oldest open escalation for this contact.
  update escalations
     set first_response_at = coalesce(escalations.first_response_at, now()),
         status            = case when escalations.status = 'open'
                                  then 'in_progress' else escalations.status end
   where escalations.id = (
     select e.id from escalations e
      where e.psid = p_psid and e.status in ('open', 'in_progress')
      order by e.created_at asc
      limit 1
   )
  returning escalations.id into v_esc;

  return query select true, v_esc;
end;
$$;

-- ============================================================================
-- SECTION 8 — HANDING THE THREAD BACK
--
-- Explicit release, for when a person is done and wants the bot to resume.
-- ============================================================================

create or replace function bot_release(
  p_psid       text,
  p_resolution text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer := 0;
begin
  update conversations
     set status = 'bot'
   where conversations.psid = p_psid
     and conversations.status in ('escalated', 'human', 'blocked');
  get diagnostics v_rows = row_count;

  update escalations
     set status      = 'resolved',
         resolved_at = now(),
         resolution  = coalesce(p_resolution, escalations.resolution)
   where escalations.psid = p_psid
     and escalations.status in ('open', 'in_progress');

  return v_rows > 0;
end;
$$;

-- ============================================================================
-- SECTION 9 — THE SWEEP
--
-- Two functions rather than one, because they answer different questions and
-- the hourly workflow does different things with each.
-- ============================================================================

-- Escalations nobody has answered yet, past their SLA, and either never
-- chased or last chased long enough ago to chase again.
create or replace function bot_pending_nudges()
returns table (
  escalation_id bigint,
  psid          text,
  display_name  text,
  question      text,
  reason        text,
  waiting_mins  integer,
  nudge_count   integer,
  transcript    jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_repeat integer;
begin
  select (value)::integer into v_repeat from bot_config where key = 'escalation_nudge_every_minutes';

  return query
  select e.id,
         e.psid,
         c.display_name,
         e.question,
         e.reason,
         (extract(epoch from (now() - e.created_at)) / 60)::integer,
         e.nudge_count,
         e.transcript
    from escalations e
    join conversations c on c.psid = e.psid
   where e.status = 'open'
     and e.first_response_at is null
     and e.sla_due_at < now()
     and (e.nudged_at is null
          or e.nudged_at < now() - make_interval(mins => coalesce(v_repeat, 60)))
   order by e.created_at asc
   limit 25;
end;
$$;

create or replace function bot_mark_nudged(p_escalation_id bigint)
returns boolean
language sql
security definer
set search_path = public
as $$
  update escalations
     set nudged_at   = now(),
         nudge_count = escalations.nudge_count + 1
   where escalations.id = p_escalation_id
  returning true;
$$;

-- Threads where a human replied and the conversation then went quiet. These
-- go back to the bot so a customer returning next week is not stuck talking
-- to a thread nobody is watching.
--
-- Deliberately narrow: a thread where NO human ever replied is never auto
-- released. Releasing that would silently drop a customer who was promised a
-- callback, which is the exact failure this whole phase exists to prevent.
create or replace function bot_auto_release()
returns table (psid text, quiet_hours integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hours integer;
begin
  select (value)::integer into v_hours from bot_config where key = 'auto_release_hours';

  return query
  with stale as (
    select c.psid,
           (extract(epoch from (now() - c.last_message_at)) / 3600)::integer as quiet_hours
      from conversations c
     where c.status = 'human'
       and c.human_last_reply_at is not null
       and c.last_message_at   < now() - make_interval(hours => coalesce(v_hours, 24))
       and c.human_last_reply_at < now() - make_interval(hours => coalesce(v_hours, 24))
     limit 100
  ),
  released as (
    update conversations c
       set status = 'bot'
      from stale s
     where c.psid = s.psid
     returning c.psid
  ),
  closed as (
    update escalations e
       set status      = 'resolved',
           resolved_at = now(),
           resolution  = 'auto-closed after quiet period'
      from stale s
     where e.psid = s.psid and e.status in ('open', 'in_progress')
     returning e.id
  )
  select s.psid, s.quiet_hours from stale s;
end;
$$;

-- ============================================================================
-- SECTION 10 — THE QUEUE
--
-- What a human needs to see, in one view: who is waiting, how long, what they
-- asked, and whether anyone has replied yet.
-- ============================================================================

create or replace view v_escalation_queue as
select
  e.id,
  e.psid,
  c.display_name,
  e.question,
  e.reason,
  e.trigger,
  e.status,
  e.created_at,
  e.sla_due_at,
  e.first_response_at,
  e.nudge_count,
  (e.first_response_at is null and e.sla_due_at < now()) as breached,
  (extract(epoch from (coalesce(e.first_response_at, now()) - e.created_at)) / 60)::integer
    as minutes_to_first_response,
  (select count(*) from messages m
    where m.psid = e.psid
      and m.direction = 'inbound'
      and m.created_at > e.created_at) as customer_messages_since
from escalations e
join conversations c on c.psid = e.psid
where e.status in ('open', 'in_progress')
order by e.created_at asc;

-- Answered / escalated / handled-by-human, per day.
create or replace view v_handoff_stats as
select
  date_trunc('day', e.created_at)::date as day,
  count(*)                                              as escalations,
  count(*) filter (where e.trigger = 'keyword')         as by_rule,
  count(*) filter (where e.trigger = 'model')           as by_model,
  count(*) filter (where e.trigger = 'repeat')          as by_repeat,
  count(*) filter (where e.first_response_at is not null) as answered_by_human,
  round(avg(extract(epoch from (e.first_response_at - e.created_at)) / 60)
        filter (where e.first_response_at is not null), 1) as avg_response_mins
from escalations e
group by 1
order by 1 desc;

-- ============================================================================
-- SECTION 11 — GRANTS AND RLS FOR THE NEW OBJECTS
-- ============================================================================

grant execute on function bot_gate(text, text, text, text)                     to bot_role;
grant execute on function bot_escalate(text, text, text, text, text)           to bot_role;
grant execute on function bot_record_human_reply(text, text, text)             to bot_role;
grant execute on function bot_release(text, text)                              to bot_role;
grant execute on function bot_pending_nudges()                                 to bot_role;
grant execute on function bot_mark_nudged(bigint)                              to bot_role;
grant execute on function bot_auto_release()                                   to bot_role;

grant select on escalation_rules to bot_role;
grant select, insert, update, delete on escalation_rules to editor_role;

-- The editor works the queue, so they need the release function too.
grant execute on function bot_release(text, text) to editor_role;

alter table escalation_rules enable row level security;

drop policy if exists escalation_rules_bot_read on escalation_rules;
create policy escalation_rules_bot_read on escalation_rules
  for select to bot_role
  using (active);

drop policy if exists escalation_rules_editor_all on escalation_rules;
create policy escalation_rules_editor_all on escalation_rules
  for all to editor_role
  using (true) with check (true);

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on escalation_rules from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on escalation_rules from authenticated;
  end if;
end
$$;
