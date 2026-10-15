-- CONTRACT STEP FOR THE RELEASE AFTER THE ONE THAT SHIPS SERVER-SIDE DATA ACCESS. NOT A MIGRATION YET.
--
-- Leaves the public anon key (and the `authenticated` role a browser could once claim with a minted
-- token) able to read, write or call nothing in the public schema (Rule 0472). PR #320 moved student
-- writes to the reader's /api routes; the server-side data access PR moved the remaining browser reads
-- (catalogue, presence roster, locks, SCORM, playground hand-ins, the error log, get_student_count,
-- get_error_counts, realtime_watch) behind them too. Browsers of earlier releases still use those
-- grants, so this file may only run once no pod or open tab of an earlier release is left. It lives
-- outside supabase/migrations (which `supabase db push` and the release harness apply), and it
-- refuses to run by accident.
--
-- Realtime is untouched: its channels and their authorization live in the `realtime` schema, which
-- this file does not name, so the browser's anon client can still join Realtime topics.
--
-- To ship it, in the release after the one that contains server-side data access (guides/SERVER-WRITES.md):
--   1. move it to supabase/migrations/<timestamp>_revoke_anon_student_data.sql;
--   2. replace the line below with "-- contract-for: v<the release that shipped server-side data access>";
--      `pnpm check:migrations` refuses it until CHANGELOG.md records that version as released;
--   3. delete the guard (the first IF in the block below), and claim its drops in release/claims.yaml.
-- contract-for: (set when promoting; see step 2)
--
-- Run by hand before then (a rehearsal on a copy of production): SET tutors.contract_ok = 'on'; first.
-- The whole file is one DO block, so when the guard refuses, nothing in it runs, whichever client
-- runs the file and whether or not it stops on the first error.
--
-- Old tabs must reload: their direct anon reads and writes fail after this step. Many tables predate
-- the migration directory on production, so the file names none of them: it walks every table, view,
-- sequence and function in the public schema, whatever exists there. Revoking grants closes access
-- even where a policy was installed by hand under another name; the policies are dropped as well so
-- that nothing reads as open.
DO $$
DECLARE
  rel record;
  pol record;
  fn record;
  browser_role text;
BEGIN
  IF coalesce(current_setting('tutors.contract_ok', true), '') <> 'on' THEN
    RAISE EXCEPTION 'revoke_anon_student_data is a contract step for the release after server-side data access; set tutors.contract_ok = on to run it deliberately';
  END IF;

  -- Every policy in the public schema that names a browser role (or PUBLIC, which includes them).
  FOR pol IN
    SELECT policyname, tablename FROM pg_policies
    WHERE schemaname = 'public' AND roles && ARRAY['anon', 'authenticated', 'public']::name[]
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol.policyname, pol.tablename);
  END LOOP;

  -- Tables, views, materialised views and sequences: no privilege for the browser roles, all for the server.
  FOR rel IN
    SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
  LOOP
    IF rel.relkind = 'S' THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON SEQUENCE public.%I FROM PUBLIC', rel.relname);
      EXECUTE format('GRANT ALL PRIVILEGES ON SEQUENCE public.%I TO service_role', rel.relname);
    ELSE
      EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM PUBLIC', rel.relname);
      EXECUTE format('GRANT ALL PRIVILEGES ON TABLE public.%I TO service_role', rel.relname);
    END IF;
    FOREACH browser_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = browser_role) THEN CONTINUE; END IF;
      IF rel.relkind = 'S' THEN
        EXECUTE format('REVOKE ALL PRIVILEGES ON SEQUENCE public.%I FROM %I', rel.relname, browser_role);
      ELSE
        EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM %I', rel.relname, browser_role);
        IF has_table_privilege(browser_role, format('public.%I', rel.relname), 'SELECT')
          OR has_table_privilege(browser_role, format('public.%I', rel.relname), 'INSERT')
          OR has_table_privilege(browser_role, format('public.%I', rel.relname), 'UPDATE')
          OR has_table_privilege(browser_role, format('public.%I', rel.relname), 'DELETE') THEN
          RAISE EXCEPTION '% still has access to %', browser_role, rel.relname;
        END IF;
      END IF;
    END LOOP;
  END LOOP;

  -- Every function in the public schema, the RPCs that took a student id from their caller
  -- (get_count_learning_records, increment_calendar, record_page_view, record_heartbeat) and the
  -- ones browsers called for reads (get_student_count, get_error_counts, realtime_watch) included.
  FOR fn IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind = 'f'
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', fn.signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn.signature);
    FOREACH browser_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = browser_role) THEN CONTINUE; END IF;
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM %I', fn.signature, browser_role);
      IF has_function_privilege(browser_role, fn.signature::text, 'EXECUTE') THEN
        RAISE EXCEPTION '% can still execute %', browser_role, fn.signature;
      END IF;
    END LOOP;
  END LOOP;

  -- Tables and functions created later get no browser grant by default either.
  FOREACH browser_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = browser_role) THEN CONTINUE; END IF;
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', browser_role);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', browser_role);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM %I', browser_role);
  END LOOP;
END $$;
