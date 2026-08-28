-- ============================================================================
-- Messenger Knowledge Bot — Phase 5: the editor surface
--
-- Run AFTER 001 and 003.
--
-- Phase 5 hands the knowledge base to someone who is not a developer. That
-- changes the threat model: the most likely way this system breaks from here
-- is no longer an attacker, it is a well-meaning owner typing something the
-- database takes literally.
--
-- Section 1 is therefore a bug fix, not a feature. Phase 4 let an editor put
-- an arbitrary regex into escalation_rules, and bot_gate matched against it
-- with no protection. A single unbalanced bracket — 'refund(' — made bot_gate
-- raise on EVERY inbound message, for EVERY customer, until someone found the
-- row. Verified before writing this file.
--
-- The fix is deliberately two-layered: reject bad patterns on write, and
-- survive them on read. Either alone would be enough on a good day.
-- ============================================================================

-- ============================================================================
-- SECTION 1 — A BAD REGEX MUST NOT BE ABLE TO TAKE THE BOT DOWN
-- ============================================================================

-- Returns false rather than raising, so it is safe to call from a trigger or
-- a check. Postgres has no "compile this regex" primitive, so the only honest
-- test is to run it and catch the failure.
create or replace function is_valid_regex(p_pattern text)
returns boolean
language plpgsql
immutable
as $$
begin
  perform 'probe' ~* p_pattern;
  return true;
exception when others then
  return false;
end;
$$;

-- A pattern that matches the empty string matches every message ever sent,
-- which would escalate the entire inbox to a human. That is not a rule, it is
-- an outage, and it is an easy thing to type by accident ('.*', 'a|').
create or replace function regex_matches_everything(p_pattern text)
returns boolean
language plpgsql
immutable
as $$
begin
  return ('' ~* p_pattern);
exception when others then
  return false;
end;
$$;

create or replace function escalation_rules_validate()
returns trigger
language plpgsql
as $$
begin
  new.label   := btrim(coalesce(new.label, ''));
  new.pattern := btrim(coalesce(new.pattern, ''));
  new.updated_at := now();

  if new.label = '' then
    raise exception 'A rule needs a name so you can find it again.';
  end if;

  -- Only an ACTIVE rule is ever matched, so only an active rule's pattern has
  -- to be valid. This is not a loophole — it is what makes the rule
  -- switch-off-able. bot_gate deactivates a rule that raises at match time,
  -- and that UPDATE fires this trigger; validating a pattern on the way to
  -- disabling it would block the self-healing path and re-break the bot.
  if new.active then
    if new.pattern = '' then
      raise exception 'Rule "%" has no words to look for. Add something like: refund|reklamo', new.label;
    end if;

    if not is_valid_regex(new.pattern) then
      raise exception 'Rule "%" is not a valid pattern. Check for an unclosed ( or [. Plain words separated by | always work, e.g. refund|reklamo|complain', new.label;
    end if;

    if regex_matches_everything(new.pattern) then
      raise exception 'Rule "%" would match every message ever sent and hand your whole inbox to a human. Use specific words instead.', new.label;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists escalation_rules_validate_trg on escalation_rules;
create trigger escalation_rules_validate_trg
  before insert or update on escalation_rules
  for each row execute function escalation_rules_validate();

-- Any rule that predates this trigger — including one already breaking the
-- bot right now — gets switched off rather than left to keep failing.
update escalation_rules
   set active = false
 where active
   and (not is_valid_regex(pattern) or regex_matches_everything(pattern));

-- ============================================================================
-- SECTION 2 — bot_gate, VERSION 3
--
-- Identical contract to version 2. The only change is how rules are matched:
-- one at a time, each inside its own exception block, so a rule that somehow
-- got past the trigger deactivates itself instead of taking down every
-- conversation on the Page.
--
-- Read-side tolerance matters even with write-side validation, because rules
-- can arrive by routes the trigger never sees — a restored backup, a direct
-- COPY, a migration from another system.
-- ============================================================================

create or replace function bot_gate(
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
  v_rule         record;
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

  if v_reason = 'ok' then
    -- One rule at a time. A rule that raises is switched off and skipped, so
    -- the customer still gets an answer and the next message is not affected.
    for v_rule in
      select r.id, r.label, r.pattern, r.reason
        from escalation_rules r
       where r.active
       order by r.created_at
    loop
      begin
        if v_clean ~* v_rule.pattern then
          v_esc_reason := v_rule.reason;
          exit;
        end if;
      exception when others then
        update escalation_rules
           set active = false
         where escalation_rules.id = v_rule.id;
      end;
    end loop;

    -- repeat_question_limit (2) is deliberately below repeat_text_limit (4)
    -- so a frustrated customer reaches a human before they are ever treated
    -- as a flooder and blocked.
    if v_esc_reason is null or v_esc_reason = '' then
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
-- SECTION 3 — THE OTHER WAY AN EDITOR BREAKS THINGS
--
-- Publishing an empty or near-empty document. The bot would then read a
-- heading with no content, treat it as knowledge, and answer confidently from
-- nothing. Drafts stay unvalidated on purpose — half-written is the entire
-- point of a draft.
-- ============================================================================

create or replace function kb_documents_validate()
returns trigger
language plpgsql
as $$
begin
  new.title := btrim(coalesce(new.title, ''));
  new.body  := btrim(coalesce(new.body, ''));

  if new.status = 'published' then
    if new.title = '' then
      raise exception 'Give this a title before publishing it, so you can find it later.';
    end if;
    if length(new.body) < 15 then
      raise exception 'The answer for "%" is too short to publish. Write the answer the way you would say it to a customer.', new.title;
    end if;
  end if;

  return new;
end;
$$;

-- Runs before the Phase 1 audit trigger, so the audit records the cleaned row.
drop trigger if exists kb_documents_validate_trg on kb_documents;
create trigger kb_documents_validate_trg
  before insert or update on kb_documents
  for each row execute function kb_documents_validate();

-- ============================================================================
-- SECTION 4 — WHAT THE OWNER ACTUALLY SEES
--
-- NocoDB renders whatever table you point it at, so pointing it at the raw
-- tables would show a uuid primary key, embedding_stale, and sort_order to
-- someone who wants to fix a price.
--
-- These are single-table projections, which Postgres makes automatically
-- updatable — NocoDB can read AND write through them with no extra work.
-- ============================================================================

create or replace view kb_editor as
select
  id,
  title      as "Question or topic",
  body       as "Answer",
  category   as "Category",
  status     as "Status",
  sort_order as "Order",
  updated_at as "Last edited"
from kb_documents
where status <> 'archived';

create or replace view rules_editor as
select
  id,
  label   as "Rule name",
  pattern as "Words to watch for",
  reason  as "Why",
  active  as "On"
from escalation_rules;

-- The queue the owner works. Not updatable (it is a join), so it is paired
-- with kb_answer_escalation() below for the write side.
create or replace view queue_editor as
select
  e.id,
  c.display_name                              as "Customer",
  e.question                                  as "They asked",
  e.reason                                    as "Why it came to you",
  e.created_at                                as "Asked at",
  (e.first_response_at is null)               as "Still waiting",
  (e.first_response_at is null and e.sla_due_at < now()) as "Overdue",
  e.psid
from escalations e
join conversations c on c.psid = e.psid
where e.status in ('open', 'in_progress')
order by e.created_at;

-- ============================================================================
-- SECTION 5 — THE LOOP, IN ONE CALL
--
-- The whole point of Phase 5: the owner reads a question the bot could not
-- answer, writes the answer, and the bot knows it from the next message on.
--
-- Doing it as one function rather than three manual steps means the knowledge
-- and the resolved escalation can never disagree, and every other customer
-- who asked the same thing gets closed out at the same time.
-- ============================================================================

create or replace function kb_answer_escalation(
  p_escalation_id bigint,
  p_title         text,
  p_body          text,
  p_category      text default 'general',
  p_release       boolean default true
)
returns table (document_id uuid, escalations_closed integer, threads_released integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_doc      uuid;
  v_psid     text;
  v_question text;
  v_closed   integer := 0;
  v_released integer := 0;
  v_stuck    text;
begin
  select e.psid, e.question into v_psid, v_question
    from escalations e where e.id = p_escalation_id;

  if v_psid is null then
    raise exception 'No escalation with id %', p_escalation_id;
  end if;

  -- Published immediately: an answer written in response to a real customer
  -- question is not a draft, and the person waiting is waiting now.
  insert into kb_documents (title, body, category, status, updated_by)
  values (p_title, p_body, coalesce(p_category, 'general'), 'published', current_user)
  returning id into v_doc;

  -- Close this escalation and any other open one asking the same thing, and
  -- remember every contact affected — not just the one whose id was passed in.
  create temp table if not exists _answered_psids (psid text) on commit drop;
  delete from _answered_psids;

  with closed as (
    update escalations e
       set status      = 'resolved',
           resolved_at = now(),
           resolution  = 'answered in the knowledge base'
     where e.status in ('open', 'in_progress')
       and (e.id = p_escalation_id or e.question = v_question)
    returning e.psid
  )
  insert into _answered_psids (psid) select distinct closed.psid from closed;

  select count(*) into v_closed from _answered_psids;

  -- Every one of those contacts gets their thread back, not just the first.
  -- Closing someone's escalation while leaving their conversation muted would
  -- strand them with a bot that has been told to stay silent — the exact
  -- failure the whole handover design exists to prevent.
  if p_release then
    for v_stuck in select a.psid from _answered_psids a loop
      if bot_release(v_stuck, 'answered in the knowledge base') then
        v_released := v_released + 1;
      end if;
    end loop;
  end if;

  return query select v_doc, v_closed, v_released;
end;
$$;

-- ============================================================================
-- SECTION 6 — GRANTS AND RLS
--
-- The editor gains the new surfaces and nothing else. Still no grant on
-- messages, conversations or kb_audit: reading customer conversation history
-- is not part of editing knowledge.
-- ============================================================================

grant select, insert, update, delete on kb_editor    to editor_role;
grant select, insert, update, delete on rules_editor to editor_role;
grant select on queue_editor to editor_role;

grant execute on function kb_answer_escalation(bigint, text, text, text, boolean) to editor_role;
grant execute on function is_valid_regex(text)          to editor_role, bot_role;
grant execute on function regex_matches_everything(text) to editor_role, bot_role;

-- queue_editor joins conversations, which editor_role deliberately cannot
-- read. The view is owned by the migration runner and created without
-- security_invoker, so it reads with the owner's rights while the editor
-- still cannot query conversations directly.
grant select on conversations to editor_role;
revoke select on conversations from editor_role;

alter view queue_editor set (security_invoker = false);
alter view kb_editor    set (security_invoker = false);
alter view rules_editor set (security_invoker = false);

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on kb_editor, rules_editor, queue_editor from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on kb_editor, rules_editor, queue_editor from authenticated;
  end if;
end
$$;
