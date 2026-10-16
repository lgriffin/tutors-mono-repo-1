@instructor
Feature: Contextual feedback
  As a lecturer
  I want to attach feedback to a lab step, a shared snippet or a shared reflection
  So that a student, or everyone working on a step, sees my explanation where it applies

  An annotation is anchored to exactly one thing and addressed to one student or everyone on the
  step; one for everyone is a broadcast. Only an educator the course's published enrollment lists
  may post. These Rules drive the Feedback use cases over the in-memory adapters; the reader's
  server route is in shared/feedback-server.feature, and the banner, the cards and the history on a
  lab step in student/step-feedback.feature.

  Background:
    Given "ellen" teaches the course "cs101"
    And the step "02" of the lab "/lab/cs101/lab-01" in the course "cs101"

  @rule-0400 @ears-ubiquitous
  Rule: Tutors shall anchor an annotation to exactly one of a lab step, a submission or a shared reflection, with an audience of one student or everyone on the step.

    Scenario Outline: Each anchor and audience is accepted
      When "ellen" annotates <anchor> for <audience>
      Then the annotation shall be anchored to the "<kind>" at the step "02"
      And the annotation shall be addressed to "<to>"

      Examples:
        | anchor                     | audience              | kind       | to       |
        | the step                   | "alice"               | step       | alice    |
        | the snippet "gist-7"       | "alice"               | snippet    | alice    |
        | the reflection "refl-3"    | "alice"               | reflection | alice    |
        | the step                   | everyone on the step  | step       | everyone |

    Scenario: Two anchors are refused
      When "ellen" annotates the snippet "gist-7" and the reflection "refl-3" for "alice"
      Then the annotation shall be refused as "two-anchors"
      And tutors shall have stored no annotation

    Scenario: Two audiences are refused
      When "ellen" annotates the step for "alice" and everyone on the step
      Then the annotation shall be refused as "two-audiences"
      And tutors shall have stored no annotation

  @rule-0401 @ears-event-driven
  Rule: When an educator posts an annotation, tutors shall store it with the author and time and publish a feedback-posted event.

    Scenario: An annotation is stored and announced
      Given the clock reads "2026-01-05T10:15:00.000Z"
      When "ellen" annotates the step for everyone on the step
      Then tutors shall have stored the annotation by "ellen" at "2026-01-05T10:15:00.000Z"
      And tutors shall have published one feedback-posted event for it

  @rule-0402 @ears-unwanted
  Rule: If an actor who is not in the course's educator list posts an annotation, then tutors shall refuse it with 403 and store nothing.

    Scenario: A student cannot annotate
      When "alice" annotates the step for everyone on the step
      Then the annotation shall be refused with 403
      And tutors shall have stored no annotation
      And tutors shall have published no feedback-posted event
