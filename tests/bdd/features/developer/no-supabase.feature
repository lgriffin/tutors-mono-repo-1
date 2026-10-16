@developer
Feature: No Supabase
  As a maintainer of Tutors
  I want nothing in the repository to reach Supabase
  So that the rows live in the Postgres store and realtime runs on Valkey, with no second path to keep working

  The Supabase exit (S1 to S4) moved every table into the Postgres store (db/migrations, read and
  written by the reader's and time's servers) and every realtime topic onto Valkey. S4 copied the
  rows out with `pnpm db:move` (guides/DATA-MOVE.md), then deleted the Supabase adapters, the
  supabase/ directory and the switches that chose between the two.

  @rule-0572 @ears-ubiquitous
  Rule: Tutors shall depend on no Supabase client and read no Supabase setting, in any app, package, script or deployment file.

    Scenario: No workspace package depends on a Supabase client
      Given the package manifests of the workspace
      Then no manifest names a dependency in the "@supabase" scope
      And the lockfile holds no package in the "@supabase" scope

    Scenario: No source file imports a Supabase client or reads a Supabase setting
      Given the TypeScript, JavaScript and Svelte sources of the apps, packages and scripts
      Then no source imports a module in the "@supabase" scope
      And no source reads "PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, PRIVATE_SUPABASE_SERVICE_ROLE_KEY, DATA_STORE, PUBLIC_REALTIME"

    Scenario: No deployment file sets a Supabase setting
      Given the environment example, the compose files and the Kubernetes manifests
      Then none sets "PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, PRIVATE_SUPABASE_SERVICE_ROLE_KEY, DATA_STORE, PUBLIC_REALTIME"
      And the repository has no "supabase" directory
