-- ============================================================================
-- Messenger Knowledge Bot — Phase 6 behaviour tests
--
-- Run AFTER 001, 003, 005 and 007, against a scratch database.
--
--   psql "$SCRATCH_DB_URL" -f db/001_messenger_bot_schema.sql
--   psql "$SCRATCH_DB_URL" -f db/003_phase4_escalation.sql
--   psql "$SCRATCH_DB_URL" -f db/005_editor_surface.sql
--   psql "$SCRATCH_DB_URL" -f db/007_retrieval.sql
--   psql "$SCRATCH_DB_URL" -f db/008_retrieval_tests.sql
--
-- Embeddings here are synthetic: one-hot 1536-dim vectors, so two different
-- positions are exactly orthogonal (cosine distance 1) and the same position
-- is identical (distance 0). That makes "the vector search found it" and
-- "the vector search missed it" precisely controllable, which is what R7
-- needs to prove hybrid search is actually earning its complexity.
--
-- Each \echo states the expectation. All 19 pass on Postgres 16 + pgvector.
-- ============================================================================

\pset format aligned

-- A one-hot vector at position p. Deterministic, and orthogonal to any other.
create or replace function test_vec(p integer)
returns vector(1536)
language sql
immutable
as $$
  select ('[' || string_agg(case when i = p then '1' else '0' end, ',' order by i) || ']')::vector
    from generate_series(1, 1536) i;
$$;

-- The same vector as a JSON array, which is what kb_store_chunks expects.
-- to_jsonb(vector) would produce a JSON *string*, not an array.
create or replace function test_vec_json(p integer)
returns jsonb
language sql
immutable
as $$
  select jsonb_agg(case when i = p then 1 else 0 end order by i)
    from generate_series(1, 1536) i;
$$;

-- Re-runnable.
delete from kb_documents where title like 'RTEST %';

\echo '=== R1: a short document becomes exactly one chunk ==='
insert into kb_documents (title, body, category, status) values
  ('RTEST hours', 'We are open 10:00am to 8:00pm daily, including holidays.', 'general', 'published');
select chunk_index, heading, left(chunk_text, 40) as text_start
  from kb_chunk_document((select id from kb_documents where title = 'RTEST hours'));

\echo '=== R2: the heading is prepended to what gets embedded, so a bare price is not orphaned ==='
select left(embed_input, 60) as embed_input_start
  from kb_chunk_document((select id from kb_documents where title = 'RTEST hours'));

\echo '=== R3: a long document splits at paragraph boundaries, with overlap carried forward ==='
insert into kb_documents (title, body, category, status) values
  ('RTEST long',
   repeat('Paragraph one about our deep tissue massage service and what it includes. ', 12) ||
   E'\n\n' ||
   repeat('Paragraph two about cancellation and rescheduling policy in detail. ', 12) ||
   E'\n\n' ||
   repeat('Paragraph three about parking and how to find the building entrance. ', 12),
   'services', 'published');
select count(*) as chunks, max(length(chunk_text)) as longest
  from kb_chunk_document((select id from kb_documents where title = 'RTEST long'));

\echo '=== R4: chunking is deterministic — the same document twice gives identical text ==='
select bool_and(a.chunk_text = b.chunk_text) as identical
  from kb_chunk_document((select id from kb_documents where title = 'RTEST long')) a
  join kb_chunk_document((select id from kb_documents where title = 'RTEST long')) b
    on a.chunk_index = b.chunk_index;

\echo '=== R5: a never-indexed published document shows up as pending ==='
select title, reason from kb_ingestion_pending(50) where title like 'RTEST %' order by title;

\echo '=== R6: storing chunks clears the stale flag and removes it from the queue ==='
select kb_store_chunks(
  (select id from kb_documents where title = 'RTEST hours'),
  jsonb_build_array(jsonb_build_object(
    'chunk_index', 0,
    'heading', 'RTEST hours',
    'chunk_text', 'We are open 10:00am to 8:00pm daily, including holidays.',
    'embed_input', 'RTEST hours\nWe are open 10:00am to 8:00pm daily.',
    'embedding', test_vec_json(1)
  )),
  'text-embedding-3-small') as chunks_stored;
select embedding_stale from kb_documents where title = 'RTEST hours';
select count(*) as still_pending from kb_ingestion_pending(50) where title = 'RTEST hours';

\echo '=== R7: THE POINT OF HYBRID — an exact term the vector search cannot see ==='
insert into kb_documents (title, body, category, status) values
  ('RTEST hmo', 'We do not accept HMO cards such as Maxicare or Intellicare for any service.', 'payments', 'published');
select kb_store_chunks(
  (select id from kb_documents where title = 'RTEST hmo'),
  jsonb_build_array(jsonb_build_object(
    'chunk_index', 0, 'heading', 'RTEST hmo',
    'chunk_text', 'We do not accept HMO cards such as Maxicare or Intellicare for any service.',
    'embed_input', 'RTEST hmo',
    'embedding', test_vec_json(999)
  )),
  'text-embedding-3-small') as stored;
\echo '--- query vector points at position 1 (the hours doc), NOWHERE NEAR the HMO doc ---'
\echo '--- pure vector search would rank HMO last or miss it; keyword search finds it ---'
select heading, vector_rank, keyword_rank, round(score::numeric, 5) as score
  from kb_search(test_vec(1), 'do you accept HMO cards')
 where heading like 'RTEST %'
 order by score desc;

\echo '=== R8: a paraphrase with no shared keywords is still found, by vector alone ==='
select heading, vector_rank, keyword_rank
  from kb_search(test_vec(999), 'zzznomatchingkeyword')
 where heading like 'RTEST %'
 order by score desc limit 2;

\echo '=== R9: wrong embedding dimensions are refused before anything is written ==='
\set ON_ERROR_STOP off
select kb_store_chunks(
  (select id from kb_documents where title = 'RTEST hours'),
  jsonb_build_array(jsonb_build_object(
    'chunk_index', 0, 'heading', 'x', 'chunk_text', 'x', 'embed_input', 'x',
    'embedding', jsonb_build_array(0.1, 0.2, 0.3)
  )),
  'some-other-model');
\set ON_ERROR_STOP on
\echo '--- and the existing chunk is untouched ---'
select count(*) as hours_chunks_intact from kb_chunks c
  join kb_documents d on d.id = c.document_id where d.title = 'RTEST hours';

\echo '=== R10: storing zero chunks is refused — it would silently delete the document from search ==='
\set ON_ERROR_STOP off
select kb_store_chunks((select id from kb_documents where title = 'RTEST hours'), '[]'::jsonb, 'text-embedding-3-small');
\set ON_ERROR_STOP on

\echo '=== R11: re-indexing with FEWER chunks leaves no orphans behind ==='
select kb_store_chunks(
  (select id from kb_documents where title = 'RTEST long'),
  jsonb_build_array(
    jsonb_build_object('chunk_index',0,'heading','RTEST long','chunk_text','a','embed_input','a','embedding', test_vec_json(10)),
    jsonb_build_object('chunk_index',1,'heading','RTEST long','chunk_text','b','embed_input','b','embedding', test_vec_json(11)),
    jsonb_build_object('chunk_index',2,'heading','RTEST long','chunk_text','c','embed_input','c','embedding', test_vec_json(12))
  ), 'text-embedding-3-small') as first_pass;
select kb_store_chunks(
  (select id from kb_documents where title = 'RTEST long'),
  jsonb_build_array(
    jsonb_build_object('chunk_index',0,'heading','RTEST long','chunk_text','a','embed_input','a','embedding', test_vec_json(10))
  ), 'text-embedding-3-small') as second_pass;
select count(*) as chunks_now from kb_chunks c
  join kb_documents d on d.id = c.document_id where d.title = 'RTEST long';

\echo '=== R12: editing a document marks it stale, so the next sweep re-indexes it ==='
update kb_documents set body = 'We are open 9:00am to 9:00pm daily now, including holidays.'
 where title = 'RTEST hours';
select embedding_stale from kb_documents where title = 'RTEST hours';
select title, reason from kb_ingestion_pending(50) where title = 'RTEST hours';

\echo '=== R13: changing the embedding model makes EVERY indexed document pending ==='
update bot_config set value = 'text-embedding-3-large' where key = 'embedding_model';
select count(*) as pending_after_model_change from kb_ingestion_pending(100) where title like 'RTEST %';
select title, reason from kb_ingestion_pending(100) where title = 'RTEST hmo';
update bot_config set value = 'text-embedding-3-small' where key = 'embedding_model';

\echo '=== R14: the health view says out loud whether retrieval is trustworthy ==='
select enabled, model, chunks, chunks_missing_vectors, docs_awaiting_reindex, distinct_models
  from v_retrieval_health;
\echo '--- retrieval ships OFF, so Phase 6 changes nothing until someone turns it on ---'
select value as retrieval_enabled from bot_config where key = 'retrieval_enabled';

\echo '=== R15: with retrieval OFF, kb_context returns the whole published base ==='
select source, count(*) as docs from kb_context(test_vec(1), 'HMO cards') group by source;

\echo '=== R16: with retrieval ON, kb_context returns ranked chunks instead ==='
update bot_config set value = 'true' where key = 'retrieval_enabled';
select source, title, round(score::numeric, 5) as score
  from kb_context(test_vec(1), 'do you accept HMO cards')
 where title like 'RTEST %' order by score desc;

\echo '=== R17: a WEAK match still returns chunks, and that is correct ==='
\echo '--- vector search always returns the nearest rows, however far away ---'
\echo '--- the model then declines from thin context; the gap lands in the queue ---'
select distinct source from kb_context(test_vec(1400), 'zzz nothing matches this at all');

\echo '=== R17b: THE SAFETY NET — an EMPTY index falls back to full context ==='
\echo '--- this is the real outage guard: ingestion never ran, or every vector missing ---'
create temp table _saved_chunks as select * from kb_chunks;
delete from kb_chunks;
select distinct source from kb_context(test_vec(1), 'do you accept HMO cards');
select count(*) > 0 as got_context_anyway
  from kb_context(test_vec(1), 'do you accept HMO cards');
\echo '--- without this the bot would decline EVERY question and escalate the whole inbox ---'
-- Explicit columns: fts is a generated column and cannot be inserted into.
insert into kb_chunks (id, document_id, chunk_index, heading, chunk_text,
                       embed_input, embedding, embedding_model, embedded_at,
                       category, created_at)
select id, document_id, chunk_index, heading, chunk_text,
       embed_input, embedding, embedding_model, embedded_at,
       category, created_at
  from _saved_chunks;
drop table _saved_chunks;
update bot_config set value = 'false' where key = 'retrieval_enabled';

\echo '=== R18: base64 wrapper stores identically to the direct call ==='
select kb_store_chunks_b64(
  (select id from kb_documents where title = 'RTEST hmo'),
  encode(convert_to(jsonb_build_array(jsonb_build_object(
    'chunk_index', 0, 'heading', 'RTEST hmo', 'chunk_text', 'via base64',
    'embed_input', 'RTEST hmo via base64', 'embedding', test_vec_json(999)
  ))::text, 'UTF8'), 'base64'),
  'text-embedding-3-small') as stored_via_b64;
select chunk_text from kb_chunks c join kb_documents d on d.id = c.document_id
 where d.title = 'RTEST hmo';
