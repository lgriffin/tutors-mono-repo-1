Feature: Student data in plain Postgres
  As the team running Tutors
  I want the reader and time servers to keep student data in a Postgres database we run ourselves
  So that a deployment's student data lives in plain Postgres with a schema we migrate ourselves

  Background:
    Given the course "web-dev-101" is published with 2 labs and "eve" as its educator

  @rule-0476 @ears-ubiquitous
  Rule: Tutors shall keep the schema of the Postgres store as plain SQL migrations under db/migrations that create every table the store reads and writes, with no row-level security, policy, role or Supabase auth schema.

    Scenario: The migrations build the store on an empty database
      When the migrations under db/migrations are applied to an empty Postgres database
      Then every table the Postgres store reads and writes exists
      And no table has row-level security or a policy
      And no migration names a Supabase role or the auth schema

  @rule-0477 @ears-ubiquitous
  Rule: The reader shall read and write student data in the Postgres database at PRIVATE_DATABASE_URL.

    Scenario: A lab visit on a Postgres deployment is stored in Postgres
      Given the reader's server is deployed with a database URL
      And "Alice" is signed in to the reader
      When the browser posts a page load of the first lab of "web-dev-101"
      Then the Postgres database holds the learning record and calendar row of "alice"

  @rule-0478 @ears-ubiquitous
  Rule: Tutors shall hold the Postgres store to the same contract suites as the in-memory stores for every store port.

    Scenario: The Postgres store keeps every store port's contract
      When the contract suites of ProfilePort, AccessStore, LearningEventSink, ScormRecords, SnippetStore, PlaygroundSnapshots, AssistanceStore, FeedbackStore and InsightsRead run against the Postgres store
      Then every case passes

  @rule-0479 @ears-unwanted
  Rule: If a server is deployed without PRIVATE_DATABASE_URL, then the reader shall answer 503 to each of its data routes and read or write no row.

    Scenario: A Postgres deployment with no database URL
      Given "Alice" is signed in to the reader
      And the reader's server is deployed with no database URL
      When the browser asks the reader for the content locks of "web-dev-101"
      Then the reader answers 503
      And the reader opened no connection to a database

  @rule-0480 @ears-event-driven
  Rule: When the migration command runs against a Postgres database, tutors shall apply in name order only the migrations not yet recorded there, each in one transaction that a failure rolls back.

    Scenario: A second run applies nothing
      Given the migrations under db/migrations were applied to an empty Postgres database
      When the migrations under db/migrations are applied again
      Then no migration is applied a second time

    Scenario: A failing migration leaves nothing behind and stops the run
      Given the migrations under db/migrations were applied to an empty Postgres database
      When a migration that creates a table and then fails is applied, followed by one more
      Then the run fails naming the failing migration
      And the failing migration's table does not exist
      And neither new migration is recorded
