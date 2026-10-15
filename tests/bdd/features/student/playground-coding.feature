@student
Feature: Playground Coding
  As a student working through an exercise
  I want to write and run code in the page I am reading
  So that I can practise without installing anything or signing in

  @rule-0420 @ears-ubiquitous
  Rule: The reader shall run a student's playground code in a sandboxed frame on an origin of its own.

    Scenario: Student code never runs on the reader's own origin
      Given a student opens a playground
      Then the reader frames the run-time with scripts allowed and the reader's origin withheld
      And the reader addresses that frame with a token of its own
      And the reader ignores run-time messages from anywhere else on the page

  @rule-0421 @ears-event-driven
  Rule: When a student runs a playground, the reader shall send the whole workspace to the run-time and show its output with a verdict.

    Scenario: Run the code in the workspace
      Given a student opens a playground
      When the student runs a workspace of "main.py" and "helper.py"
      Then the run-time receives the files "main.py" and "helper.py"

    Scenario: Output arrives as it is printed
      Given a student opens a playground
      When the run-time prints "42" while the code is still running
      Then the student sees "42" before the run has finished

    Scenario: A failed run is reported as one
      Given a student opens a playground
      When the run-time reports a "SyntaxError: invalid syntax" and finishes
      Then the run is reported as failed with "SyntaxError" in its output

  @rule-0422 @ears-event-driven
  Rule: When a student runs the checks of a playground, the reader shall send the tests alongside the student's files without adding them to the workspace.

    Scenario: Run the checks the lecturer wrote
      Given a playground of "main.py" with a tests file "test_main.py"
      When the student runs the checks
      Then the run-time receives a test run of "main.py" and "test_main.py"
      And the student's workspace holds "main.py" only

  @rule-0423 @ears-state-driven
  Rule: While a student has edited a playground before, the reader shall reopen the exercise with their edits and their own files in place.

    @active
    Scenario: Work is kept between visits without an account
      Given a playground of "main.py" reading "print('todo')"
      And the student saved "main.py" reading "print('done')" and a file of their own "scratch.py"
      When the student reopens the playground
      Then "main.py" reads "print('done')"
      And the workspace holds "scratch.py"

    @inactive
    Scenario: A first visit opens the exercise as authored
      Given a playground of "main.py" reading "print('todo')"
      When the student reopens the playground
      Then "main.py" reads "print('todo')"
      And the workspace holds "main.py" only

  @rule-0424 @ears-event-driven
  Rule: When a lecturer adds a file to a playground a student has edited, the reader shall deliver the new file beside the student's unchanged edits.

    Scenario: The lecturer adds a file to an exercise already started
      Given a playground of "main.py" reading "print('todo')"
      And the student saved "main.py" reading "print('mine')"
      When the lecturer adds "helper.py" to the exercise
      And the student reopens the playground
      Then the workspace holds "helper.py"
      And "main.py" reads "print('mine')"

  @rule-0425 @ears-optional
  Rule: Where the author marked a playground file read-only, the reader shall present that file as read-only in its current authored version.

    @active
    Scenario: Scaffolding the student is not meant to change
      Given a playground whose "scaffold.py" is read-only and reads "VERSION = 2"
      And the student saved "scaffold.py" reading "VERSION = 1"
      When the student reopens the playground
      Then "scaffold.py" is read-only
      And "scaffold.py" reads "VERSION = 2"

    @inactive
    Scenario: An ordinary file stays the student's own
      Given a playground of "main.py" reading "print('todo')"
      And the student saved "main.py" reading "print('mine')"
      When the student reopens the playground
      Then "main.py" is editable
      And "main.py" reads "print('mine')"

  @rule-0426 @ears-event-driven
  Rule: When a student shares a playground as a link, the reader shall carry the whole workspace in the link's fragment.

    Scenario: Share a workspace with someone who is not signed in
      Given a student has a workspace of "main.py" and "helper.py"
      When the student shares it as a link
      Then the link decodes to the same workspace
      And the link carries the workspace in its fragment and nothing in its query

  @rule-0427 @ears-unwanted
  Rule: If a playground run is still running after the time limit, then the reader shall stop it, say so and discard the run-time.

    Scenario: Code that never finishes
      Given a student opens a playground with a time limit of 50 milliseconds
      When the run-time never answers the run
      Then the run is reported as failed because it was still running
      And the run-time is restarted

  @rule-0428 @ears-unwanted
  Rule: If a student stops a playground run, then the reader shall answer the waiting run as stopped.

    Scenario: A student changes their mind mid-run
      Given a student opens a playground
      When the student presses stop during a run
      Then the run is reported as failed with "Stopped." in its output

  @rule-0429 @ears-unwanted
  Rule: If a shared link's fragment is not a workspace, then the reader shall open the exercise as authored.

    Scenario: A shared link that is not one
      Given a playground of "main.py" reading "print('todo')"
      When the student opens a link whose fragment is "something-someone-typed"
      Then the link decodes to nothing
      And "main.py" reads "print('todo')"
