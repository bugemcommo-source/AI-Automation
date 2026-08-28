-- ============================================================================
-- Messenger Knowledge Bot — Phase 2 schema
--
-- Target: Supabase Postgres (plain Postgres 14+ also works).
-- Run once, top to bottom, in the Supabase SQL editor.
--
-- Creates:
--   * five tables (knowledge, conversations, messages, escalations, audit)
--   * one guard function that does dedupe + rate limiting + spend capping
--     atomically in a single round trip
--   * two least-privilege roles: one for the bot, one for the knowledge editor
--   * RLS on every table
--
-- The bot NEVER connects as postgres/service_role. See the GRANTS section.
-- ============================================================================

create extension if not exists pgcrypto;

-- ============================================================================
-- SECTION 1 — CONFIGURATION
--
-- Every tunable lives here as a row, so limits can be changed without a deploy.
-- ============================================================================

create table if not exists bot_config (
  key           text primary key,
  value         text        not null,
  description   text        not null,
  updated_at    timestamptz not null default now()
);

insert into bot_config (key, value, description) values
  ('rate_limit_per_hour',   '20',   'Max inbound messages per person per rolling hour'),
  ('rate_limit_per_day',    '60',   'Max inbound messages per person per rolling day'),
  ('repeat_text_limit',     '4',    'Max identical messages from one person within 10 minutes'),
  ('new_contact_burst',     '8',    'Max messages in the first 5 minutes from a brand-new contact'),
  ('global_daily_message_cap', '5000', 'Hard stop across all contacts per UTC day'),
  ('global_daily_spend_usd','25.00','Hard stop on model spend per UTC day'),
  ('max_input_chars',       '1000', 'Inbound text longer than this is truncated before the model sees it')
on conflict (key) do nothing;

-- ============================================================================
-- SECTION 2 — THE KNOWLEDGE BASE
--
-- The only table a non-developer ever touches. Surfaced through NocoDB.
--
-- `status` is the safety interlock: the bot reads ONLY 'published'. An editor
-- can leave a half-written price change sitting in 'draft' indefinitely and no
-- customer will ever see it.
-- ============================================================================

create table if not exists kb_documents (
  id              uuid        primary key default gen_random_uuid(),
  title           text        not null,
  body            text        not null,
  category        text        not null default 'general',
  status          text        not null default 'draft'
                              check (status in ('draft', 'published', 'archived')),
  sort_order      integer     not null default 100,
  -- Phase 6: an edit flips this true; the ingestion sweep re-embeds only what changed.
  embedding_stale boolean     not null default true,
  updated_by      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- The bot's read path. Partial index because it only ever reads published rows.
create index if not exists kb_documents_published_idx
  on kb_documents (sort_order, title)
  where status = 'published';

-- ---------------------------------------------------------------------------
-- Audit trail. Answers "the bot quoted the wrong price — who changed it, when?"
-- ---------------------------------------------------------------------------

create table if not exists kb_audit (
  id          bigserial   primary key,
  document_id uuid,
  action      text        not null,
  actor       text,
  old_row     jsonb,
  new_row     jsonb,
  changed_at  timestamptz not null default now()
);

create index if not exists kb_audit_document_idx on kb_audit (document_id, changed_at desc);

create or replace function kb_documents_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (tg_op = 'DELETE') then
    insert into kb_audit (document_id, action, actor, old_row, new_row)
    values (old.id, 'delete', current_user, to_jsonb(old), null);
    return old;
  end if;

  -- Any content change invalidates the embedding and stamps the clock.
  new.updated_at := now();
  if (tg_op = 'UPDATE') then
    if (new.body is distinct from old.body or new.title is distinct from old.title) then
      new.embedding_stale := true;
    end if;
    insert into kb_audit (document_id, action, actor, old_row, new_row)
    values (new.id, 'update', current_user, to_jsonb(old), to_jsonb(new));
  else
    insert into kb_audit (document_id, action, actor, old_row, new_row)
    values (new.id, 'insert', current_user, null, to_jsonb(new));
  end if;
  return new;
end;
$$;

drop trigger if exists kb_documents_audit_trg on kb_documents;
create trigger kb_documents_audit_trg
  before insert or update or delete on kb_documents
  for each row execute function kb_documents_audit();

-- ============================================================================
-- SECTION 3 — CONVERSATIONS
--
-- One row per person who has ever messaged the Page. Keyed on the PSID, which
-- is the Page-Scoped ID Meta gives us — it is unique per Page, not globally,
-- which is why it is the natural primary key here.
-- ============================================================================

create table if not exists conversations (
  psid              text        primary key,
  display_name      text,
  locale            text,
  status            text        not null default 'bot'
                                check (status in ('bot', 'escalated', 'human', 'blocked')),
  first_seen_at     timestamptz not null default now(),
  last_message_at   timestamptz not null default now(),
  last_bot_reply_at timestamptz,
  message_count     integer     not null default 0,
  -- GoHighLevel linkage. Null until the contact is first synced.
  ghl_contact_id    text,
  ghl_synced_at     timestamptz,
  ghl_sync_error    text
);

create index if not exists conversations_status_idx on conversations (status)
  where status <> 'bot';
create index if not exists conversations_ghl_pending_idx on conversations (last_message_at)
  where ghl_contact_id is null;

-- ============================================================================
-- SECTION 4 — MESSAGES
--
-- Every message, both directions. `mid` is Meta's message id and the dedupe
-- key: Meta retries webhooks it believes failed, so without this UNIQUE
-- constraint the same customer question gets answered — and billed — twice.
--
-- Outbound rows have no mid from Meta, so the constraint is partial.
-- ============================================================================

create table if not exists messages (
  id           bigserial   primary key,
  psid         text        not null references conversations (psid) on delete cascade,
  direction    text        not null check (direction in ('inbound', 'outbound')),
  mid          text,
  body         text        not null,
  -- Null for inbound. For outbound: did the bot answer from the knowledge base,
  -- or did it decline and escalate? This column is the headline quality metric.
  answered     boolean,
  escalated    boolean     not null default false,
  tokens_in    integer,
  tokens_out   integer,
  cost_usd     numeric(10, 6) not null default 0,
  created_at   timestamptz not null default now()
);

create unique index if not exists messages_mid_key on messages (mid) where mid is not null;
create index if not exists messages_psid_time_idx on messages (psid, created_at desc);
create index if not exists messages_spend_idx on messages (created_at) where cost_usd > 0;
-- Supports the "unanswered questions" report that drives the content backlog.
create index if not exists messages_unanswered_idx on messages (created_at desc)
  where direction = 'outbound' and answered = false;

-- ============================================================================
-- SECTION 5 — ESCALATIONS
--
-- The work queue. Every row is a knowledge gap a real customer found for you.
-- ============================================================================

create table if not exists escalations (
  id          bigserial   primary key,
  psid        text        not null references conversations (psid) on delete cascade,
  question    text        not null,
  reason      text        not null default 'no_grounded_answer',
  transcript  jsonb,
  status      text        not null default 'open'
                          check (status in ('open', 'in_progress', 'resolved', 'wont_fix')),
  resolution  text,
  created_at  timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists escalations_open_idx on escalations (created_at desc)
  where status = 'open';

-- ============================================================================
-- SECTION 6 — THE GUARD FUNCTION
--
-- This is the anti-spam layer, and it is deliberately ONE function rather than
-- a chain of IF nodes in n8n.
--
-- Why: every check here is a read-then-decide. Spread across separate nodes,
-- two messages arriving 50ms apart both read "19 messages this hour", both
-- decide they are under the limit of 20, and both proceed. Inside a single
-- statement against a single snapshot, that race cannot happen.
--
-- It also means the whole gate is ONE database round trip instead of six, and
-- a rejected message costs zero model tokens because the workflow stops before
-- it ever reaches Claude.
--
-- Returns exactly one row:
--   allow          — proceed to the model?
--   reason         — why not, when allow = false
--   is_new_contact — drives the greeting
--   status         — conversation status, so an escalated thread stays quiet
--   history        — recent turns, so the workflow needs no second query
-- ============================================================================

create or replace function bot_gate(
  p_psid text,
  p_mid  text,
  p_text text,
  p_name text default null
)
returns table (
  allow          boolean,
  reason         text,
  is_new_contact boolean,
  status         text,
  clean_text     text,
  history        jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cfg              jsonb;
  v_max_chars        integer;
  v_clean            text;
  v_is_new           boolean := false;
  v_status           text;
  v_inserted         boolean := false;
  v_rows             integer := 0;
  v_hour_count       integer;
  v_day_count        integer;
  v_repeat_count     integer;
  v_global_count     integer;
  v_global_spend     numeric;
  v_reason           text := 'ok';
begin
  -- Pull every tunable in one shot.
  select jsonb_object_agg(key, value) into v_cfg from bot_config;
  v_max_chars := (v_cfg ->> 'max_input_chars')::integer;

  -- Normalise. Truncation is a real control: it caps the token cost of a
  -- single hostile message regardless of what anyone pastes in.
  v_clean := left(btrim(coalesce(p_text, '')), v_max_chars);

  -- ---- Upsert the contact -------------------------------------------------
  insert into conversations (psid, display_name, last_message_at, message_count)
  values (p_psid, p_name, now(), 1)
  on conflict (psid) do update
    set last_message_at = now(),
        message_count   = conversations.message_count + 1,
        display_name    = coalesce(conversations.display_name, excluded.display_name)
  returning (xmax = 0) into v_is_new;

  select conversations.status into v_status from conversations where psid = p_psid;

  -- ---- Record the inbound message. This is also the dedupe check. ---------
  -- ON CONFLICT DO NOTHING means a replayed webhook inserts zero rows, and we
  -- detect the replay by asking whether anything was inserted.
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

  -- ---- Gates, cheapest and most decisive first ---------------------------

  if not v_inserted then
    v_reason := 'duplicate_mid';
  elsif v_status = 'blocked' then
    v_reason := 'blocked';
  elsif v_status in ('escalated', 'human') then
    -- A human owns this thread. The bot must not talk over them.
    v_reason := 'human_handling';
  elsif v_clean = '' then
    v_reason := 'empty_message';
  else
    select count(*) into v_hour_count
      from messages
     where psid = p_psid and direction = 'inbound'
       and created_at > now() - interval '1 hour';

    select count(*) into v_day_count
      from messages
     where psid = p_psid and direction = 'inbound'
       and created_at > now() - interval '1 day';

    select count(*) into v_repeat_count
      from messages
     where psid = p_psid and direction = 'inbound'
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

  -- Auto-block a persistent flooder so the next message is rejected by the
  -- cheap status check above instead of five count(*) queries.
  -- Column references are table-qualified: this function has OUT parameters
  -- named `status` and `allow`, which shadow the column names otherwise.
  if v_reason in ('rate_limit_day', 'repeated_text') then
    update conversations set status = 'blocked'
     where conversations.psid = p_psid and conversations.status = 'bot';
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
    );
end;
$$;

-- ============================================================================
-- SECTION 7 — RECORDING THE REPLY
--
-- One call: log the outbound message, attach cost, and open an escalation if
-- the bot declined. Keeping this in SQL means the escalation and the message
-- row can never disagree about whether a question was answered.
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
  v_id bigint;
begin
  insert into messages (psid, direction, body, answered, escalated,
                        tokens_in, tokens_out, cost_usd)
  values (p_psid, 'outbound', p_body, p_answered, not p_answered,
          p_tokens_in, p_tokens_out, coalesce(p_cost_usd, 0))
  returning id into v_id;

  update conversations set last_bot_reply_at = now() where psid = p_psid;

  if not p_answered then
    insert into escalations (psid, question, reason, transcript)
    values (
      p_psid,
      coalesce(p_question, '(not captured)'),
      'no_grounded_answer',
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
    update conversations set status = 'escalated'
     where conversations.psid = p_psid and conversations.status = 'bot';
  end if;

  return v_id;
end;
$$;

-- ============================================================================
-- SECTION 8 — ROLES AND GRANTS
--
-- Least privilege, enforced by plain Postgres grants rather than RLS, because
-- these are service connections rather than end users.
--
--   bot_role    — what n8n connects as. Can run the two guard functions and
--                 read published knowledge. Cannot read kb_audit, cannot write
--                 to kb_documents, cannot see draft content.
--   editor_role — what NocoDB connects as. Can edit knowledge and work the
--                 escalation queue. CANNOT read `messages` — the editor has no
--                 business reading customer conversation history.
--
-- Change both passwords before running, and store them only in the n8n and
-- NocoDB credential stores.
-- ============================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'bot_role') then
    create role bot_role login password 'CHANGE_ME_BOT';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'editor_role') then
    create role editor_role login password 'CHANGE_ME_EDITOR';
  end if;
end
$$;

grant usage on schema public to bot_role, editor_role;

-- --- the bot -----------------------------------------------------------------
grant execute on function bot_gate(text, text, text, text)                       to bot_role;
grant execute on function bot_record_reply(text, text, boolean, integer, integer, numeric, text) to bot_role;
grant select on bot_config   to bot_role;
grant select on kb_documents to bot_role;
grant select, update on conversations to bot_role;
grant select on escalations  to bot_role;
-- Postgres Chat Memory creates and manages its own table.
grant create on schema public to bot_role;

-- --- the knowledge editor ----------------------------------------------------
grant select, insert, update, delete on kb_documents to editor_role;
grant select, update on escalations to editor_role;
grant select on bot_config to editor_role;
grant usage, select on sequence escalations_id_seq to editor_role;
-- Deliberately NOT granted: messages, kb_audit, conversations.

-- ============================================================================
-- SECTION 9 — ROW LEVEL SECURITY
--
-- Supabase exposes every table in the public schema through PostgREST using
-- the anon key, which is designed to be public. A table without RLS is a table
-- anyone can read. RLS is therefore enabled everywhere, and no policy is
-- written for anon or authenticated — the default deny IS the policy.
--
-- RLS applies to bot_role and editor_role too, so each needs an explicit
-- policy for what it is allowed to see. This is a feature, not a chore: the
-- draft interlock becomes a database guarantee rather than a WHERE clause
-- someone might forget. Even if the workflow asked for every row, the bot
-- physically cannot read a draft.
--
-- `force` is deliberately NOT used. The two guard functions are SECURITY
-- DEFINER and run as the table owner; forcing RLS on the owner would break
-- them on any deployment where the owner is not a superuser.
-- ============================================================================

alter table bot_config    enable row level security;
alter table kb_documents  enable row level security;
alter table kb_audit      enable row level security;
alter table conversations enable row level security;
alter table messages      enable row level security;
alter table escalations   enable row level security;

-- --- the bot -----------------------------------------------------------------
drop policy if exists kb_documents_bot_read on kb_documents;
create policy kb_documents_bot_read on kb_documents
  for select to bot_role
  using (status = 'published');

drop policy if exists conversations_bot_rw on conversations;
create policy conversations_bot_rw on conversations
  for all to bot_role
  using (true) with check (true);

drop policy if exists escalations_bot_read on escalations;
create policy escalations_bot_read on escalations
  for select to bot_role
  using (true);

drop policy if exists bot_config_bot_read on bot_config;
create policy bot_config_bot_read on bot_config
  for select to bot_role
  using (true);

-- --- the knowledge editor ----------------------------------------------------
-- Sees every status, because managing drafts is the whole job.
drop policy if exists kb_documents_editor_all on kb_documents;
create policy kb_documents_editor_all on kb_documents
  for all to editor_role
  using (true) with check (true);

drop policy if exists escalations_editor_rw on escalations;
create policy escalations_editor_rw on escalations
  for all to editor_role
  using (true) with check (true);

drop policy if exists bot_config_editor_read on bot_config;
create policy bot_config_editor_read on bot_config
  for select to bot_role, editor_role
  using (true);

-- `messages` and `kb_audit` get NO policy for either role. Neither service
-- reaches them directly — the bot goes through the SECURITY DEFINER functions,
-- and the editor has no business reading customer conversations at all.

-- Supabase ships the `anon` and `authenticated` roles; plain Postgres does not.
-- Guarded so this file runs unchanged on both.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on bot_config, kb_documents, kb_audit, conversations, messages, escalations
      from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on bot_config, kb_documents, kb_audit, conversations, messages, escalations
      from authenticated;
  end if;
end
$$;

-- ============================================================================
-- SECTION 10 — REPORTING VIEWS
--
-- The four metrics worth watching, as views so a dashboard never has to
-- reimplement the definitions and drift from them.
-- ============================================================================

create or replace view v_answer_rate as
select
  date_trunc('day', created_at)::date          as day,
  count(*)                                     as replies,
  count(*) filter (where answered)             as answered,
  round(100.0 * count(*) filter (where answered) / nullif(count(*), 0), 1) as answer_rate_pct,
  round(sum(cost_usd), 2)                      as cost_usd
from messages
where direction = 'outbound'
group by 1
order by 1 desc;

create or replace view v_content_backlog as
select
  question,
  count(*)          as times_asked,
  max(created_at)   as last_asked
from escalations
where status = 'open'
group by question
order by times_asked desc, last_asked desc;

create or replace view v_daily_spend as
select
  date_trunc('day', created_at)::date as day,
  round(sum(cost_usd), 4)             as spend_usd,
  count(*) filter (where direction = 'inbound')  as inbound,
  count(*) filter (where direction = 'outbound') as outbound
from messages
group by 1
order by 1 desc;

-- ============================================================================
-- SECTION 11 — SEED
--
-- Two published rows so the bot has something to answer with on the very first
-- test message, and one draft row proving the interlock works: ask the bot
-- about parking and it must decline, because that row is not published.
-- ============================================================================

insert into kb_documents (title, body, category, status, sort_order) values
  ('Opening hours',
   'We are open 10:00am to 8:00pm, seven days a week, including public holidays. Last booking is taken at 7:00pm.',
   'general', 'published', 10),
  ('Deep tissue massage pricing',
   'Deep tissue massage is PHP 1,800 for 60 minutes and PHP 2,500 for 90 minutes. Price includes a hot towel finish. We do not currently accept HMO cards for any service.',
   'pricing', 'published', 20),
  ('Parking',
   'DRAFT — do not publish until confirmed with building admin.',
   'general', 'draft', 30)
on conflict do nothing;

-- ============================================================================
-- PHASE 6 — not created yet. Left here as the shape to add when retrieval
-- earns its place. `embedding_stale` on kb_documents already feeds it.
--
--   create extension if not exists vector;
--   create table kb_chunks (
--     id              uuid primary key default gen_random_uuid(),
--     document_id     uuid not null references kb_documents (id) on delete cascade,
--     chunk_text      text not null,
--     embedding       vector(1536) not null,
--     embedding_model text not null,
--     embedded_at     timestamptz not null default now(),
--     metadata        jsonb not null default '{}'::jsonb
--   );
--   create index on kb_chunks using hnsw (embedding vector_cosine_ops);
-- ============================================================================
