Feature: Moving the rows out of Supabase
  As the team moving Tutors off Supabase
  I want one command that copies every row the Postgres store keeps out of the Supabase project and proves the copy
  So that the deployment can switch to DATA_STORE=postgres without losing a learning record, and Supabase can then be deleted

  Background:
    Given a Supabase database with the store's tables, the Realtime budget tables and rows in them
    And an empty Postgres store with db/migrations applied

  @rule-0486 @ears-event-driven
  Rule: When the data move is planned, tutors shall report each table it copies, each Supabase table it leaves behind, each store table that starts empty and each column that blocks the copy.

    Scenario: The plan names what is copied and what is not
      When the data move is planned
      Then the plan copies "learning_records", "tutors-connect-users" and "scorm_records"
      And the plan leaves "realtime_budget" and "realtime_settings" behind in Supabase
      And the plan starts "assistance_requests" empty
      And the plan has no blocker

    Scenario: A Supabase column the store lacks blocks the move
      Given Supabase's "learning_records" table has a column "legacy_score" the store does not
      When the data move is planned
      Then the plan is blocked by "learning_records.legacy_score"

  @rule-0487 @ears-event-driven
  Rule: When the data move runs, tutors shall copy every row of each table it planned to copy from the Supabase database into the Postgres store.

    Scenario: Every row of every shared table arrives
      When the data move runs
      Then the store holds 250 learning records, 2 users and 1 SCORM record
      And the store holds no Realtime budget table

  @rule-0488 @ears-unwanted
  Rule: If the plan has a blocker, or a table to copy already holds rows in the store and the move was not asked to replace them, then tutors shall copy no row.

    Scenario: A store table that already holds rows stops the whole move
      Given the store already holds a learning record of "carol"
      When the data move runs
      Then the move is refused naming "learning_records"
      And the store holds 0 users

    Scenario: A move asked to replace them empties the tables first
      Given the store already holds a learning record of "carol"
      When the data move runs replacing what the store holds
      Then the store holds 250 learning records, 2 users and 1 SCORM record

    Scenario: A blocked plan copies nothing
      Given Supabase's "learning_records" table has a column "legacy_score" the store does not
      When the data move runs
      Then the move is refused naming "learning_records.legacy_score"
      And the store holds 0 users

  @rule-0489 @ears-event-driven
  Rule: When the data move is verified, tutors shall compare each copied table's row count and checksum in Supabase and in the store and name each table that differs.

    Scenario: A faithful copy matches table by table
      Given the data move has run
      When the data move is verified
      Then every copied table matches

    Scenario: A changed row is caught
      Given the data move has run
      And one learning record's duration was changed in the store
      When the data move is verified
      Then only "learning_records" differs
