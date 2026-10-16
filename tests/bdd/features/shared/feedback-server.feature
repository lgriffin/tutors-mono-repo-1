@shared
Feature: Lecturer feedback on the reader's server
  As a lecturer explaining a lab, and a student reading it
  I want feedback kept and changed only by the reader's server, as the person signed in
  So that nobody posts as a lecturer, and nobody reads what was written to someone else

  Annotations and shared reflections are kept in Postgres (feedback_annotations and
  feedback_reflections); a broadcast travels on Valkey on the course's help queue topic for Tutors
  Live and on the course's broadcast topic as a toast for its students. These
  Rules drive the reader's /api/feedback over a Postgres database (PGlite) and the process's memory
  hub, which stands in for Valkey.

  Background:
    Given the course "cs101" is published with 2 labs and "ellen" as its educator

  @rule-0565 @ears-ubiquitous
  Rule: Tutors shall keep and change lecturer feedback only on the reader's server as the signed-in actor, refusing a visitor who is not signed in with 401, and give a student only the broadcasts and the annotations addressed to them.

    Scenario: The educator's broadcast is kept as theirs
      Given "ellen" is signed in to the reader
      When the browser broadcasts "Await the fetch." on the step "02" of the first lab
      Then the reader shall answer 201
      And Postgres shall hold one annotation by "ellen" for "everyone" at the step "02" of the first lab

    Scenario: A visitor who is not signed in is refused
      Given nobody is signed in to the reader
      When the browser broadcasts "Await the fetch." on the step "02" of the first lab
      Then the reader shall answer 401
      And Postgres shall hold no annotation

    Scenario: A student reads the broadcast and their own annotation, never another student's
      Given "ellen" has written "For alice." to "alice" on the step "02" of the first lab
      And "ellen" has written "For bob." to "bob" on the step "02" of the first lab
      And "ellen" has broadcast "For everyone." on the step "02" of the first lab
      When "alice" reads the step "02" of the first lab
      Then the reader shall answer with the broadcast "For everyone." and the annotation "For alice." only

  @rule-0405 @ears-event-driven
  Rule: When an educator broadcasts an explanation, tutors shall publish one annotation event on the course's help queue topic to the Tutors Live tabs watching it.

    Scenario: Tutors Live hears the explanation once
      Given "ellen" is streaming the help queue of "cs101" from Tutors Live
      When "ellen" broadcasts "Await the fetch." on the step "02" of the first lab
      Then the stream shall carry one annotation for "everyone" saying "Await the fetch."

    Scenario: A personal annotation is not announced
      Given "ellen" is streaming the help queue of "cs101" from Tutors Live
      When "ellen" has written "For alice." to "alice" on the step "02" of the first lab
      Then the stream shall carry nothing

  @rule-0564 @ears-event-driven
  Rule: When an educator broadcasts an explanation, tutors shall send the course's students one toast naming the step and linking to it, without the explanation's text, and no more than one toast a minute on the course.

    The broadcast topic carries no explanation: a student reads it on the step, where the reader
    checks who is signed in. The minute is the one lecturer broadcasts share.

    Scenario: A student elsewhere in the course hears the toast
      Given "alice" is streaming the course broadcasts of "cs101"
      When "ellen" broadcasts "Await the fetch." on the step "02" of the first lab
      Then the broadcast stream shall carry one toast from "ellen" linking to the step "02" of the first lab
      And the toast shall not carry "Await the fetch."

    Scenario: A second explanation within the minute is not toasted again
      Given "alice" is streaming the course broadcasts of "cs101"
      When "ellen" broadcasts "Await the fetch." on the step "02" of the first lab
      And "ellen" broadcasts "Check the status code." on the step "03" of the first lab
      Then the broadcast stream shall carry one toast from "ellen" linking to the step "02" of the first lab
      And Postgres shall hold 2 annotations for "everyone"

  @rule-0567 @ears-unwanted
  Rule: If a signed-in reader is not admitted to a private course, then the reader shall refuse with 403 to read feedback there or keep a reflection from them on its server.

    A private course (auth level 1 with a whitelist) admits its educators and the logins on its
    whitelist, as the reader's pages do.

    Scenario: An outsider reads nothing from a private course
      Given the private course "cs201" admits "alice" and is taught by "ellen"
      And "ellen" has broadcast "A private hint." on the step "02" of the first lab
      When "mallory" reads the step "02" of the first lab
      Then the reader shall answer 403

    Scenario: An outsider cannot plant a reflection in a private course
      Given the private course "cs201" admits "alice" and is taught by "ellen"
      When "mallory" shares the note "planted" on the step "02" of the first lab
      Then the reader shall answer 403
      And Postgres shall hold no reflection

    Scenario: A student on the whitelist reads the course's feedback
      Given the private course "cs201" admits "alice" and is taught by "ellen"
      And "ellen" has broadcast "A private hint." on the step "02" of the first lab
      When "alice" reads the step "02" of the first lab
      Then the reader shall answer 200
