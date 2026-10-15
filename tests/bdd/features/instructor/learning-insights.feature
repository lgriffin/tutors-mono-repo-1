@instructor
Feature: Learning insights
  As a lecturer
  I want to see where a lab is hardest and how long students wait for help
  So that I can fix the step, change the lab or come to the room sooner

  Insights are read-only aggregations of the stored learning, assistance and feedback records of
  a bounded period, through one read port. These Rules drive the Insights use cases over the
  in-memory read port; the views in Tutors Time come in a later pull request.

  Background:
    Given the course "cs101" with the lab "/lab/cs101/lab-01"

  @rule-0410 @ears-ubiquitous
  Rule: Tutors shall compute insights only from stored learning, assistance and feedback records through one read port, never writing.

    Scenario: Insights read through the read port and leave the records as they were
      Given the stored help requests of "2026-01-05" at the step "02"
        | learner | kind | requested | acknowledged | closed   | reason   |
        | alice   | hint | 09:00:00  | 09:01:00     | 09:03:00 | hint     |
      When tutors computes the diagnostics of "2026-01-05"
      Then tutors shall have read the records through the insights read port
      And the stored records shall be unchanged

  @rule-0411 @ears-ubiquitous
  Rule: Tutors shall compute a step diagnostic as requests by kind, acknowledged count, median and 90th percentile waiting seconds, helped answers and annotations for a step and day.

    Scenario: A step's day in numbers
      Given the stored help requests of "2026-01-05" at the step "02"
        | learner | kind     | requested | acknowledged | closed   | reason   |
        | alice   | stuck    | 09:00:00  | 09:01:00     | 09:10:00 | resolved |
        | bob     | hint     | 09:00:00  |              | 09:02:00 | hint     |
        | carol   | lecturer | 09:00:00  | 09:05:00     | 09:20:00 | resolved |
        | dan     | stuck    | 09:30:00  |              |          |          |
      And a stored help request by "erin" of kind "stuck" on "2026-01-06" at the step "02"
      And 2 stored annotations at the step "02" on "2026-01-05"
      When tutors computes the diagnostics of "2026-01-05"
      Then the diagnostic of the step "02" shall count 2 "stuck", 1 "hint" and 1 "lecturer" requests
      And the diagnostic shall count 2 acknowledged
      And the diagnostic's median wait shall be 120 seconds and its 90th percentile wait 300 seconds
      And the diagnostic shall count 1 helped by a hint and 2 annotations
