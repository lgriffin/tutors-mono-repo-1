@student
Feature: Learning evidence and private notes
  As a student
  I want my work at each lab step to be recognised, and a private place to write about it
  So that I can find my discoveries and questions again and share the ones I choose

  The Learning context owns the step reference every assistance, feedback and insights record
  carries, the attempts it reads from the learning records already stored, the evidence a learner
  leaves at a step, and the learner's private notes. Notes stay in the learner's browser
  (decision D1). Objectives are out of scope (decision D7). These Rules drive the domain and the
  use cases over the in-memory adapters, and the reader's notes panel over the browser storage
  adapter (notes-localstorage); what the panel looks like on screen is ui/lab-notes.feature.

  Background:
    Given the lab "/lab/cs101/lab-01" of the course "cs101" has the steps "01, 02, 03"

  @rule-0375 @ears-ubiquitous
  Rule: Tutors shall identify a lab step by its course id, lab route and step id, and carry that reference on every assistance, feedback and insights record.

    Scenario: A step is its course, its lab and its own id
      When tutors identifies the step "02"
      Then the step reference shall be the course "cs101", the lab "/lab/cs101/lab-01" and the step "02"
      And a reference missing its course, its lab or its step shall not identify a step

    Scenario: Help requests, annotations and insights carry the step
      Given "alice" has asked for help as "stuck" on the step "02"
      And an educator has annotated the step "02"
      When tutors computes the day's diagnostics
      Then the help request, the annotation and the diagnostic shall each carry the reference of the step "02"

  @rule-0376 @ears-ubiquitous
  Rule: Tutors shall derive a learner's attempts at a step from stored learning records, never from a second record of its own.

    Scenario: Attempts are read from the learning records
      Given the learning records show "alice" visited the step "01" 3 times and the step "02" once
      When tutors reads the attempts at the lab
      Then "alice" shall have 3 visits at the step "01" and 1 visit at the step "02"
      And tutors shall have read nothing but the learning records

  @rule-0377 @ears-event-driven
  Rule: When a learner records evidence at a step, tutors shall publish an evidence-recorded event carrying the step reference and the evidence kind.

    Scenario: A shared snippet is evidence at its step
      When "alice" records a "snippet" as evidence at the step "02"
      Then tutors shall publish one evidence-recorded event for "alice" at the step "02" of kind "snippet"

  @rule-0378 @ears-state-driven
  Rule: While a learner has recorded evidence at a step, tutors shall list that evidence under the step with its kind and date, newest first.

    @active
    Scenario: Evidence at the step is listed newest first
      Given "alice" recorded a "note" at the step "02" on "2026-01-05"
      And "alice" recorded a "snippet" at the step "02" on "2026-01-07"
      And she later recorded a "reflection" at the step "03" on "2026-01-08"
      When tutors lists the evidence at the step "02"
      Then the list shall be "snippet on 2026-01-07, note on 2026-01-05"

    @inactive
    Scenario: A step with no evidence lists nothing
      Given "alice" recorded a "reflection" at the step "03" on "2026-01-08"
      When tutors lists the evidence at the step "02"
      Then the list shall be empty

  @rule-0379 @ears-unwanted
  Rule: If a learning record names a step that no longer exists in the course, then tutors shall keep the attempt under the lab with the step marked as removed.

    Scenario: A renamed step keeps its history
      Given the learning records show "alice" visited the step "01" 3 times and the step "old-step" once
      When tutors reads the attempts at the lab
      Then the attempt at the step "old-step" shall be kept under the lab "/lab/cs101/lab-01" marked as removed
      And the attempt at the step "01" shall not be marked as removed

  @rule-0380 @ears-event-driven
  Rule: When a learner edits the note of a lab step, tutors shall keep the note in the browser under the step's reference within 1 second and send nothing to a server.

    Scenario: A note is kept in the browser
      When "alice" writes "Remember to await the fetch" in the note of the step "02"
      Then the note shall be kept under "@notes/cs101/lab/cs101/lab-01/02" within 1 second
      And nothing shall have been sent to a server

    Scenario: The notes panel keeps a typed note in the browser's local storage
      When "alice" types "Remember to await the fetch" in the notes panel at the step "02"
      Then the browser's local storage shall hold "Remember to await the fetch" under "@notes/cs101/lab/cs101/lab-01/02" within 1 second
      And nothing shall have been sent to a server

  @rule-0381 @ears-state-driven
  Rule: While a learner moves between steps and labs of a course, tutors shall show each step's own note in the notes panel and keep the panel's open, minimised and width state.

    @active
    Scenario: Moving to the next step swaps the note and keeps the panel
      Given "alice" has the note "first thoughts" at the step "01" and "second thoughts" at the step "02"
      And the notes panel is open, not minimised and 420 pixels wide at the step "01"
      When "alice" moves to the step "02"
      Then the notes panel shall show "second thoughts"
      And the notes panel shall still be open, not minimised and 420 pixels wide

    @inactive
    Scenario: Staying on a step keeps its note and the panel
      Given "alice" has the note "first thoughts" at the step "01" and "second thoughts" at the step "02"
      And the notes panel is open, not minimised and 420 pixels wide at the step "01"
      When "alice" stays on the step "01"
      Then the notes panel shall show "first thoughts"
      And the notes panel shall still be open, not minimised and 420 pixels wide

  @rule-0382 @ears-event-driven
  Rule: When a learner exports a course's notes, tutors shall produce one markdown document with a heading per lab, a sub-heading per step linking to the reader, and each note's body, kind and date.

    Scenario: A course's notes export as one document
      Given "alice" has the note "first thoughts" at the step "01" and "second thoughts" at the step "02"
      When "alice" exports the notes of the course titled "Web Development"
      Then the document shall open with the heading "# Web Development notes"
      And the document shall have one lab heading "## Lab One"
      And the document shall have the step heading "### [Step 02](https://reader.example/lab/cs101/lab-01/02)" followed by "_note · 2026-01-05_" and "second thoughts"

  @rule-0383 @ears-unwanted
  Rule: If browser storage is unavailable or full, then tutors shall keep the notes of the session in memory, tell the learner once that the notes are kept for this session only, and still export them.

    Scenario: Notes survive the session when storage refuses them
      Given browser storage refuses every write
      When "alice" writes "first thoughts" in the note of the step "01"
      And "alice" writes "second thoughts" in the note of the step "02"
      Then tutors shall have told "alice" once that the notes are kept for this session only
      And the note of the step "01" shall read "first thoughts"
      And the export of the course shall contain "first thoughts" and "second thoughts"

    Scenario: The notes panel keeps the session's notes when local storage is full
      Given the browser's local storage is full
      When "alice" types "first thoughts" in the notes panel at the step "01"
      And "alice" types "second thoughts" in the notes panel at the step "02"
      Then the notes panel shall have said once that the notes are kept for this session only
      And the notes panel's export of the course shall contain "first thoughts" and "second thoughts"

  @rule-0384 @ears-optional
  Rule: Where a learner shares a note as a reflection, tutors shall copy it to the feedback context and leave the private note unchanged.

    @active
    Scenario: A shared note becomes a reflection
      Given "alice" has the note "I found the off-by-one" at the step "02"
      When "alice" shares the note of the step "02" as a reflection
      Then the feedback context shall hold a reflection by "alice" at the step "02" reading "I found the off-by-one"
      And the note of the step "02" shall still read "I found the off-by-one"

    @inactive
    Scenario: An unshared note stays private
      Given "alice" has the note "I found the off-by-one" at the step "02"
      When "alice" keeps the note of the step "02" to herself
      Then the feedback context shall hold no reflection by "alice"
