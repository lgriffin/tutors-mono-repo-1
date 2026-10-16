@student
Feature: Lecturer feedback on a lab step
  As a student working through a lab, and a lecturer reviewing it
  I want a lecturer's explanations and comments shown where they apply
  So that I read them on the step they are about, and the lecturer sees what they posted

  The reader reads a step's feedback from the reader's server (/api/feedback) as the person signed
  in, when the step opens and every minute while it stays on screen; no student joins a realtime
  channel for it. These Rules drive the reader's feedback service over the in-memory feedback desk,
  which runs the Feedback use cases as the person signed in, as the reader's server does.

  Background:
    Given "ellen" teaches the course "cs101"
    And "alice" is on the step "02" of the lab "/lab/cs101/lab-01" in the course "cs101"

  @rule-0403 @ears-event-driven
  Rule: When a student opens a lab step, the reader shall show every unrevoked broadcast for that step above the content and every annotation addressed to that student below it, from one query.

    Scenario: A broadcast and a personal annotation show where they belong
      Given "ellen" has broadcast "Await the fetch." on the step "02"
      And "ellen" has written "Nearly there, alice." to "alice" on the step "02"
      But "ellen" has written "Look at line 4, bob." to "bob" on the step "02"
      When "alice" opens the step
      Then the reader shall show the banner "Await the fetch." above the step
      And the reader shall show the card "Nearly there, alice." below the step
      And the reader shall show no other annotation
      And the step's feedback shall have been read once

    Scenario: A visitor who is not signed in sees no feedback
      Given "ellen" has broadcast "Await the fetch." on the step "02"
      When a visitor who is not signed in opens the step
      Then the reader shall show no banner and no card

  @rule-0404 @ears-state-driven
  Rule: While a student stays on a lab step, the reader shall refresh its annotations every 60 seconds without joining a realtime channel.

    @active
    Scenario: A broadcast posted while the student reads arrives within a minute
      Given "alice" opens the step
      When "ellen" broadcasts "Check the port number." on the step "02"
      And 60 seconds pass
      Then the reader shall show the banner "Check the port number." above the step
      And the reader shall have joined no realtime channel for it

    @inactive
    Scenario: A student who left the step reads no more
      Given "alice" opens the step
      And "alice" leaves the step
      When 120 seconds pass
      Then the step's feedback shall have been read once

  @rule-0406 @ears-event-driven
  Rule: When an educator revokes an annotation, the reader shall stop showing it to students on their next refresh and keep it in the review history with the revocation time.

    Scenario: A revoked broadcast leaves the step and stays in the history
      Given "ellen" has broadcast "Await the fetch." on the step "02"
      And "alice" opens the step
      And the clock reads "2026-01-05T10:30:00.000Z"
      When "ellen" revokes the broadcast "Await the fetch."
      And 60 seconds pass
      Then the reader shall show no banner and no card
      And the step's history for "ellen" shall list "Await the fetch." revoked at "2026-01-05T10:30:00.000Z"

    Scenario: A student cannot revoke
      Given "ellen" has broadcast "Await the fetch." on the step "02"
      When "alice" tries to revoke the broadcast "Await the fetch."
      Then the revoke shall be refused as "forbidden"

  @rule-0408 @ears-ubiquitous
  Rule: The reader shall render annotation bodies as markdown through the content renderer, sanitised as lab content is.

    Scenario: Markdown is rendered and a script is removed
      Given "ellen" has broadcast "Use **await** <script>alert(1)</script>here." on the step "02"
      When "alice" opens the step
      Then the banner shall render "await" in bold
      And the banner shall hold no script

  @rule-0409 @ears-ubiquitous
  Rule: The reader shall show a student the history of annotations they received in a course, newest first, and show an educator what was broadcast on a step and when.

    Scenario: A student's history is newest first and leaves out another student's
      Given the clock reads "2026-01-05T09:00:00.000Z"
      And "ellen" has broadcast "First, for everyone." on the step "02"
      And the clock reads "2026-01-05T09:10:00.000Z"
      And "ellen" has written "Then, for alice." to "alice" on the step "03"
      But "ellen" has written "For bob only." to "bob" on the step "03"
      When "alice" reads the feedback they received in "cs101"
      Then the history shall read "Then, for alice.", then "First, for everyone."

    Scenario: The educator sees what was broadcast on the step and when
      Given the clock reads "2026-01-05T09:00:00.000Z"
      And "ellen" has broadcast "First, for everyone." on the step "02"
      When "ellen" opens the step
      Then the step's history for "ellen" shall list "First, for everyone." posted at "2026-01-05T09:00:00.000Z"

    Scenario: A student sees no step history
      When "alice" opens the step
      Then the reader shall offer "alice" no step history

  @rule-0566 @ears-event-driven
  Rule: When a lecturer sends feedback on a snippet shared from a lab step, the reader shall show it below that step to the student who shared the snippet only.

    Scenario: Feedback on a snippet lands on the step it was shared from
      Given "alice" shared the snippet "gist-7" from the route "/lab/cs101/lab-01/02"
      When "ellen" sends "Close the file handle." on the snippet "gist-7" from Tutors Time
      And "alice" opens the step
      Then the reader shall show the card "Close the file handle." below the step
      And the card shall say it is on their snippet

    Scenario: A snippet shared from a lab's own page offers no feedback
      Given "alice" shared the snippet "gist-8" from the route "/lab/cs101/lab-01"
      Then Tutors Time shall offer no feedback on the snippet "gist-8"
