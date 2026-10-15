@instructor
Feature: Playground Authoring and Review
  As an instructor setting a programming exercise
  I want a folder of code to become a runnable exercise, and to see what students made of it
  So that I can set practical work without running a server for it

  Background:
    Given an instructor has authored a course with playground folders

  @rule-0430 @ears-event-driven
  Rule: When a course is built from a playground folder holding one source file, tutors shall make that file the entry point with the run-time chosen from its extension.

    Scenario: A folder of code becomes an exercise
      When the course is built
      Then the "simple" playground's entry point is "main.py"
      And the "simple" playground's run-time is "python"
      And the "oversized" playground, whose entry point is JavaScript, runs on "javascript"
      And the "simple" playground's workspace is that one file

  @rule-0431 @ears-ubiquitous
  Rule: tutors shall carry a playground folder's source and data files into the workspace, entry point first, and leave the prose out of it.

    Scenario: The workspace holds what the exercise needs and nothing else
      When the course is built
      Then the "mixed" playground's workspace holds "helper.py" and "data.json"
      And the "mixed" playground's workspace leaves out "notes.md"
      And the "mixed" playground's workspace lists "main.py" first

  @rule-0432 @ears-event-driven
  Rule: When a playground folder holds a test file, tutors shall carry the tests separately from the student's workspace.

    Scenario: Checks the student can run but not edit
      When the course is built
      Then the "mixed" playground's workspace leaves out "test_main.py"
      And the "mixed" playground's tests are "test_main.py" reading "assert double(2) == 4"

  @rule-0433 @ears-optional
  Rule: Where a playground folder declares a playground.yaml, tutors shall take the run-time, entry point, packages, tests and read-only files from it.

    @active
    Scenario: The defaults can be overridden
      When the course is built
      Then the "configured" playground's run-time is "typescript"
      And the "configured" playground's entry point is "exercise.ts"
      And the "configured" playground's packages are "lodash"
      And the "configured" playground's tests are "checks.ts" reading "console.log(answer);"
      And the "configured" playground's workspace leaves out "checks.ts"
      And the "configured" playground's "scaffold.ts" is read-only
      And the "configured" playground's "exercise.ts" is editable

    @inactive
    Scenario: A folder with no playground.yaml takes the defaults
      When the course is built
      Then the "simple" playground's run-time is "python"
      And the "simple" playground's entry point is "main.py"
      And the "simple" playground has no packages and no tests

  @rule-0434 @ears-unwanted
  Rule: If a file in a playground folder is too large to inline, then tutors shall build the workspace without it.

    Scenario: An exercise that would be a large download
      When the course is built
      Then the "oversized" playground's workspace leaves out "huge.js"
      And the "oversized" playground's workspace is "main.js" only

  @rule-0435 @ears-state-driven
  Rule: While an instructor teaches a course, the reader shall list the submissions handed in for an exercise with the output each student last saw.

    @active
    Scenario: Reviewing what students handed in
      Given an educator of the course is signed in to the reader
      And "Ada Lovelace" handed in "main.py" that printed "Traceback: NameError" and failed
      When the instructor opens the exercise's submissions
      Then the instructor reviews the course
      And the submissions list "Ada Lovelace"
      And the submission shows "main.py" with the output "NameError" and a failed verdict

    @inactive
    Scenario: A student sees no review panel
      Given a student of the course is signed in to the reader
      When the instructor opens the exercise's submissions
      Then the reader does not treat the student as a reviewer

  @rule-0436 @ears-unwanted
  Rule: If a page claims a student teaches a course, then the reader shall grant review from the course's published educators, read by its server, and from nothing else.

    Scenario: A student cannot make themselves an instructor
      Given a student of the course is signed in to the reader
      When the instructor opens the exercise's submissions
      Then the reader does not treat the student as a reviewer
      And the reader answers 403 when the student asks for "Ada Lovelace"'s submission
      And the submissions table is closed to the anonymous role

  @rule-0437 @ears-unwanted
  Rule: If the reader's server has no database to keep hand-ins in, then the reader shall offer no handing in while the exercise itself still runs.

    Scenario: A deployment with no service key
      Given the reader's server has no service key
      When the instructor opens the exercise's submissions
      Then handing in is not available
      And the submissions are empty
      And the exercise's workspace still opens as authored
