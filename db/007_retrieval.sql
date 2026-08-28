-- ============================================================================
-- Messenger Knowledge Bot — Phase 6: retrieval
--
-- Run AFTER 001, 003 and 005.
--
-- Until now the whole knowledge base went into the system prompt on every
-- message, cached. That is the right design while the base is small, and this
-- migration does NOT change it by default: `retrieval_enabled` ships as false.
--
-- Turning it on is a one-row edit, and turning it off again is the same edit.
-- That matters more than it sounds. Retrieval is the first change in this
-- build that can make answers *worse* rather than merely broken — a bad
-- chunking or a stale index degrades quality quietly, and the only honest
-- response to that is a switch you can flip back in seconds.
--
-- Design notes worth knowing before reading the SQL:
--
--   * Search is HYBRID: vector similarity fused with Postgres full-text.
--     Pure vector search is bad at exact tokens — prices, "HMO", "GCash",
--     a product code — which is exactly the sort of thing customers ask
--     about. Keyword search is bad at paraphrase. Neither alone is enough.
--
--   * Fusion is Reciprocal Rank Fusion, which combines by RANK rather than by
--     score. Cosine distance and ts_rank are not on comparable scales, so
--     averaging them is meaningless; averaging their ranks is not.
--
--   * Chunking happens HERE, in SQL, not in the workflow. It has to be
--     deterministic and re-runnable, and a Code node that produces slightly
--     different chunks on a retry is a silently corrupted index.
-- ============================================================================

create extension if not exists vector;

-- ============================================================================
-- SECTION 1 — CONFIG
-- ============================================================================

insert into bot_config (key, value, description) values
  ('retrieval_enabled',      'false', 'Retrieve top chunks instead of sending the whole knowledge base. Off until the base outgrows the prompt.'),
  ('retrieval_top_k',        '6',     'Chunks handed to the model per question'),
  ('retrieval_candidates',   '24',    'Rows pulled from each of vector and keyword search before fusion'),
  ('retrieval_min_score',    '0.015', 'Fused score below which a chunk is dropped as noise'),
  ('embedding_model',        'text-embedding-3-small', 'Changing this requires re-embedding EVERYTHING'),
  ('embedding_dimensions',   '1536',  'Must match the model above. Changing it is a full rebuild.'),
  ('chunk_max_chars',        '1400',  'Longer documents are split at paragraph boundaries'),
  ('chunk_overlap_chars',    '160',   'Carried between consecutive chunks so a sentence is never orphaned')
on conflict (key) do nothing;

-- ============================================================================
-- SECTION 2 — THE CHUNKS
--
-- One row per retrievable unit. For FAQ-shaped content that is one row per
-- document; only a genuinely long document gets split.
--
-- `heading` is stored separately and prepended to the embedded text, because
-- a naked chunk retrieves badly — "PHP 1,800 for 60 minutes" is ambiguous
-- without "Deep tissue massage pricing" attached to it.
-- ============================================================================

create table if not exists kb_chunks (
  id              uuid        primary key default gen_random_uuid(),
  document_id     uuid        not null references kb_documents (id) on delete cascade,
  chunk_index     integer     not null,
  heading         text        not null,
  chunk_text      text        not null,
  -- What was actually sent to the embedding API: heading + text. Kept so a
  -- re-embed can be verified byte-for-byte against what produced the vector.
  embed_input     text        not null,
  embedding       vector(1536),
  embedding_model text,
  embedded_at     timestamptz,
  category        text        not null default 'general',
  fts             tsvector generated always as (
                    to_tsvector('english', coalesce(heading, '') || ' ' || coalesce(chunk_text, ''))
                  ) stored,
  created_at      timestamptz not null default now(),
  unique (document_id, chunk_index)
);

-- HNSW over cosine distance. Built on a small table this is instant; on a
-- large one it is still the right index because recall stays high as the
-- corpus grows.
create index if not exists kb_chunks_embedding_idx
  on kb_chunks using hnsw (embedding vector_cosine_ops);

create index if not exists kb_chunks_fts_idx on kb_chunks using gin (fts);
create index if not exists kb_chunks_document_idx on kb_chunks (document_id);
-- Chunks with no vector yet are the ingestion backlog.
create index if not exists kb_chunks_unembedded_idx on kb_chunks (created_at)
  where embedding is null;

-- ============================================================================
-- SECTION 3 — CHUNKING
--
-- Deterministic: the same document always produces the same chunks, so a
-- retried ingestion run cannot leave the index half-rewritten with slightly
-- different text.
--
-- Splits on blank lines first, because a paragraph break is a real semantic
-- boundary that a character count is only guessing at. A paragraph longer
-- than the limit on its own is then split by sentence.
-- ============================================================================

create or replace function kb_chunk_document(p_document_id uuid)
returns table (chunk_index integer, heading text, chunk_text text, embed_input text)
language plpgsql
stable
as $$
declare
  v_doc      record;
  v_max      integer;
  v_overlap  integer;
  v_para     text;
  v_buf      text := '';
  v_idx      integer := 0;
  v_tail     text;
begin
  select d.title, d.body, d.category into v_doc
    from kb_documents d where d.id = p_document_id;

  if v_doc is null then
    return;
  end if;

  select (value)::integer into v_max     from bot_config where key = 'chunk_max_chars';
  select (value)::integer into v_overlap from bot_config where key = 'chunk_overlap_chars';
  v_max     := coalesce(v_max, 1400);
  v_overlap := coalesce(v_overlap, 160);

  for v_para in
    select btrim(p) from regexp_split_to_table(coalesce(v_doc.body, ''), E'\\n\\s*\\n') as p
     where btrim(p) <> ''
  loop
    -- Emit what we have and start a new chunk when adding this paragraph
    -- would overflow. The overlap tail carries the end of the previous chunk
    -- forward so a thought split across the boundary is still findable.
    if v_buf <> '' and length(v_buf) + length(v_para) + 2 > v_max then
      chunk_index := v_idx;
      heading     := v_doc.title;
      chunk_text  := v_buf;
      embed_input := v_doc.title || E'\n' || v_buf;
      return next;
      v_idx := v_idx + 1;

      v_tail := right(v_buf, v_overlap);
      v_buf  := v_tail || E'\n\n' || v_para;
    elsif v_buf = '' then
      v_buf := v_para;
    else
      v_buf := v_buf || E'\n\n' || v_para;
    end if;
  end loop;

  if btrim(coalesce(v_buf, '')) <> '' then
    chunk_index := v_idx;
    heading     := v_doc.title;
    chunk_text  := v_buf;
    embed_input := v_doc.title || E'\n' || v_buf;
    return next;
  end if;
end;
$$;

-- ============================================================================
-- SECTION 4 — THE INGESTION CONTRACT
--
-- Two functions the ingestion workflow calls. Everything about which
-- documents need work lives here rather than in the workflow, so the
-- workflow cannot drift from the definition of "stale".
-- ============================================================================

-- Published documents whose chunks are missing, stale, or embedded with a
-- different model than the one currently configured. That last case is what
-- makes a model change a safe, resumable operation rather than a manual
-- rebuild: change the config row, and every document becomes stale.
create or replace function kb_ingestion_pending(p_limit integer default 20)
returns table (document_id uuid, title text, category text, reason text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_model text;
begin
  select value into v_model from bot_config where key = 'embedding_model';

  return query
  select d.id, d.title, d.category,
         case
           when not exists (select 1 from kb_chunks c where c.document_id = d.id) then 'never_indexed'
           when d.embedding_stale then 'edited'
           when exists (select 1 from kb_chunks c
                         where c.document_id = d.id
                           and (c.embedding is null or c.embedding_model is distinct from v_model))
             then 'model_changed'
           else 'unknown'
         end
    from kb_documents d
   where d.status = 'published'
     and (
       d.embedding_stale
       or not exists (select 1 from kb_chunks c where c.document_id = d.id)
       or exists (select 1 from kb_chunks c
                   where c.document_id = d.id
                     and (c.embedding is null or c.embedding_model is distinct from v_model))
     )
   order by d.updated_at asc
   limit greatest(coalesce(p_limit, 20), 1);
end;
$$;

-- Replaces every chunk for one document in a single transaction, then clears
-- the stale flag. Delete-then-insert rather than upsert because a re-chunk can
-- produce FEWER chunks than before, and an upsert would leave the extras
-- behind as orphans that still match searches.
--
-- p_chunks is [{"chunk_index":0,"heading":"...","chunk_text":"...",
--               "embed_input":"...","embedding":[0.01,...]}, ...]
create or replace function kb_store_chunks(
  p_document_id uuid,
  p_chunks      jsonb,
  p_model       text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dims     integer;
  v_expected integer;
  v_count    integer := 0;
  v_cat      text;
  v_first    jsonb;
begin
  select (value)::integer into v_expected from bot_config where key = 'embedding_dimensions';
  select category into v_cat from kb_documents where id = p_document_id;

  if v_cat is null then
    raise exception 'No document %', p_document_id;
  end if;

  if p_chunks is null or jsonb_array_length(p_chunks) = 0 then
    raise exception 'Refusing to store zero chunks for document % — that would silently remove it from search', p_document_id;
  end if;

  -- Guard the dimension before writing anything. A mismatch here means the
  -- embedding model was changed without updating embedding_dimensions, and
  -- writing it would corrupt the index with vectors of two different shapes.
  v_first := p_chunks -> 0;

  if jsonb_typeof(v_first -> 'embedding') is distinct from 'array' then
    raise exception 'Chunk 0 has no "embedding" array (got %). The embedding must be a JSON array of numbers, not a string or a pgvector literal.',
      coalesce(jsonb_typeof(v_first -> 'embedding'), 'nothing');
  end if;

  v_dims := jsonb_array_length(v_first -> 'embedding');
  if v_dims is distinct from v_expected then
    raise exception 'Embedding has % dimensions but embedding_dimensions is %. Check the model and the config row before re-running.', v_dims, v_expected;
  end if;

  delete from kb_chunks where document_id = p_document_id;

  insert into kb_chunks (document_id, chunk_index, heading, chunk_text,
                         embed_input, embedding, embedding_model, embedded_at, category)
  select p_document_id,
         (c ->> 'chunk_index')::integer,
         c ->> 'heading',
         c ->> 'chunk_text',
         c ->> 'embed_input',
         (c ->> 'embedding')::vector,
         p_model,
         now(),
         v_cat
    from jsonb_array_elements(p_chunks) c;

  get diagnostics v_count = row_count;

  update kb_documents set embedding_stale = false where id = p_document_id;

  return v_count;
end;
$$;

-- ============================================================================
-- SECTION 5 — HYBRID SEARCH
--
-- Vector search finds paraphrase. Keyword search finds exact tokens. A
-- customer asking "do you take HMO" needs the second; one asking "is it safe
-- if I'm expecting" needs the first. Running both and fusing by rank gets
-- both without tuning a weight between incomparable scores.
--
-- Reciprocal Rank Fusion: score = sum over each result list of 1/(k + rank).
-- k = 60 is the value from the original RRF paper and is not sensitive.
-- ============================================================================

create or replace function kb_search(
  p_query_embedding vector(1536),
  p_query_text      text,
  p_top_k           integer default null
)
returns table (
  chunk_id     uuid,
  document_id  uuid,
  heading      text,
  chunk_text   text,
  category     text,
  score        double precision,
  vector_rank  integer,
  keyword_rank integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_k          integer;
  v_candidates integer;
  v_min        double precision;
  v_rrf_k      constant integer := 60;
begin
  select (value)::integer          into v_k          from bot_config where key = 'retrieval_top_k';
  select (value)::integer          into v_candidates from bot_config where key = 'retrieval_candidates';
  select (value)::double precision into v_min        from bot_config where key = 'retrieval_min_score';

  v_k          := coalesce(p_top_k, v_k, 6);
  v_candidates := coalesce(v_candidates, 24);
  v_min        := coalesce(v_min, 0.0);

  return query
  with vec as (
    select c.id,
           row_number() over (order by c.embedding <=> p_query_embedding) as rnk
      from kb_chunks c
     where c.embedding is not null
     order by c.embedding <=> p_query_embedding
     limit v_candidates
  ),
  kw as (
    select c.id,
           row_number() over (
             order by ts_rank(c.fts, websearch_to_tsquery('english', p_query_text)) desc
           ) as rnk
      from kb_chunks c
     where p_query_text is not null
       and btrim(p_query_text) <> ''
       and c.fts @@ websearch_to_tsquery('english', p_query_text)
     limit v_candidates
  ),
  fused as (
    select coalesce(vec.id, kw.id)                      as id,
           (coalesce(1.0 / (v_rrf_k + vec.rnk), 0.0)
          + coalesce(1.0 / (v_rrf_k + kw.rnk), 0.0))::double precision as score,
           vec.rnk                                      as vrank,
           kw.rnk                                       as krank
      from vec
      full outer join kw on kw.id = vec.id
  )
  select c.id, c.document_id, c.heading, c.chunk_text, c.category,
         f.score, f.vrank::integer, f.krank::integer
    from fused f
    join kb_chunks c on c.id = f.id
   where f.score >= v_min
   order by f.score desc
   limit v_k;
end;
$$;

-- ============================================================================
-- SECTION 6 — HEALTH
--
-- Retrieval fails quietly. A stale index does not raise, it just answers
-- slightly worse, so it needs something that says out loud whether it is
-- currently trustworthy.
-- ============================================================================

create or replace view v_retrieval_health as
select
  (select value from bot_config where key = 'retrieval_enabled')::boolean as enabled,
  (select value from bot_config where key = 'embedding_model')            as model,
  (select count(*) from kb_documents where status = 'published')          as published_docs,
  (select count(*) from kb_chunks)                                        as chunks,
  (select count(*) from kb_chunks where embedding is null)                as chunks_missing_vectors,
  (select count(*) from kb_documents where status = 'published' and embedding_stale) as docs_awaiting_reindex,
  (select count(distinct embedding_model) from kb_chunks where embedding_model is not null) as distinct_models,
  (select max(embedded_at) from kb_chunks)                                as last_indexed_at;

-- ============================================================================
-- SECTION 7 — GRANTS AND RLS
-- ============================================================================

grant execute on function kb_search(vector, text, integer)        to bot_role;
grant execute on function kb_ingestion_pending(integer)           to bot_role;
grant execute on function kb_store_chunks(uuid, jsonb, text)      to bot_role;
grant execute on function kb_chunk_document(uuid)                 to bot_role;
grant select on kb_chunks to bot_role;
grant select on v_retrieval_health to bot_role, editor_role;

alter table kb_chunks enable row level security;

drop policy if exists kb_chunks_bot_read on kb_chunks;
create policy kb_chunks_bot_read on kb_chunks
  for select to bot_role
  using (true);

-- The editor never touches chunks. They edit documents; chunks are derived,
-- and letting anyone hand-edit a derived table is how an index and its source
-- quietly stop agreeing.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on kb_chunks from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on kb_chunks from authenticated;
  end if;
end
$$;

-- Editing a document already sets embedding_stale (Phase 1 trigger). Deleting
-- one cascades its chunks away. Nothing else has to be maintained by hand.

-- ============================================================================
-- SECTION 8 — WHAT THE WORKFLOW ACTUALLY CALLS
--
-- Two wrappers. Both exist because of real constraints outside the database.
-- ============================================================================

-- n8n's Postgres node passes query parameters as a COMMA-SEPARATED STRING, so
-- any value containing a comma is silently split into several parameters. A
-- JSON array of embeddings is nothing but commas.
--
-- Base64 has no commas, so the workflow encodes the payload and this unwraps
-- it. Ugly, but the alternative is building SQL by string concatenation from
-- knowledge-base content, which is an injection waiting to happen.
create or replace function kb_store_chunks_b64(
  p_document_id uuid,
  p_chunks_b64  text,
  p_model       text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
begin
  return kb_store_chunks(
    p_document_id,
    convert_from(decode(p_chunks_b64, 'base64'), 'UTF8')::jsonb,
    p_model
  );
end;
$$;

-- The single call the conversation flow makes to get its knowledge, whichever
-- mode is active. Returning one shape from both modes means the workflow has
-- no branch to keep in sync, and switching modes is genuinely a config edit.
--
-- The fallback matters more than the switch. Be precise about what it covers:
-- vector search always returns SOMETHING when the index has rows — the nearest
-- chunks, however far away — so this does not fall back on a weak match. It
-- falls back when the result set is genuinely EMPTY: an index that was never
-- built, an ingestion that never ran, every chunk still awaiting a vector.
--
-- Those are the cases that would otherwise hand the model zero context, making
-- it decline every question and escalate the entire inbox — a quiet indexing
-- problem surfacing as a visible outage. A weak match is a different thing and
-- is handled where it should be: the model declines from thin context, and the
-- question lands in the escalation queue as a knowledge gap.
create or replace function kb_context(
  p_query_embedding vector(1536) default null,
  p_query_text      text         default null
)
returns table (title text, category text, body text, source text, score double precision)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_enabled boolean;
  v_hits    integer := 0;
begin
  select (value)::boolean into v_enabled from bot_config where key = 'retrieval_enabled';

  if coalesce(v_enabled, false) and p_query_embedding is not null then
    select count(*) into v_hits
      from kb_search(p_query_embedding, coalesce(p_query_text, ''));

    if v_hits > 0 then
      return query
      select s.heading, s.category, s.chunk_text, 'retrieval'::text, s.score
        from kb_search(p_query_embedding, coalesce(p_query_text, '')) s;
      return;
    end if;
  end if;

  return query
  select d.title, d.category, d.body, 'full'::text, null::double precision
    from kb_documents d
   where d.status = 'published'
   order by d.sort_order, d.title;
end;
$$;

grant execute on function kb_store_chunks_b64(uuid, text, text)   to bot_role;
grant execute on function kb_context(vector, text)                to bot_role;
