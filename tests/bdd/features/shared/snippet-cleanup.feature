@shared
Feature: Snippet cleanup
  As a lecturer whose students share snippets
  I want an expired snippet to leave the store
  So that a snippet is kept for 48 hours and no longer

  Reads already hide an expired snippet (Rule 0461). The nightly Snippet Cleanup workflow
  (scripts/purge-course-gists.ts) deletes the rows from the Postgres store, in batches.

  @rule-0581 @ears-event-driven
  Rule: When the snippet cleanup runs, tutors shall delete from the store every snippet whose expiry has passed and keep every other snippet.

    Scenario: Expired snippets go and the rest stay
      Given the store holds 5 snippets that have expired and 4 that have not
      When the snippet cleanup runs in batches of 2
      Then the cleanup reports 5 snippets deleted
      And the store holds the 4 snippets that have not expired

    Scenario: A dry run deletes nothing
      Given the store holds 5 snippets that have expired and 4 that have not
      When the snippet cleanup runs as a dry run
      Then the cleanup reports 5 snippets deleted
      And the store holds 9 snippets
