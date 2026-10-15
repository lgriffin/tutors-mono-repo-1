@student
Feature: Asking for help from a lab step
  As a student working through a lab
  I want a help control on the step, the lecturer's hint where I asked, and to say whether help helped
  So that help reaches me where I am and the lecturer learns what works

  The reader's help control is helpService in svelte-state and HelpButton and HelpNotice on the lab
  step. It asks through the HelpDesk the reader composed (the reader's server, POST
  /api/assistance), and reads the student's own request from stored rows, never the course's queue
  (Rule 0392). These Rules drive helpService over the in-memory help desk, which runs the
  Assistance use cases as the person signed in.

  Background:
    Given "ellen" teaches the course "cs101"
    And "alice" is on the step "02" of the lab "/lab/cs101/lab-01" in the course "cs101"

  @rule-0397 @ears-event-driven
  Rule: When a lecturer answers a hint request with a typed hint, tutors shall show the hint to that student on the step and resolve the request as helped by a hint.

    Scenario: The student reads the lecturer's hint on the step
      Given "alice" is signed in and asked for help as "hint"
      When "ellen" answers the request with the hint "Check the loop bound."
      And the reader reads the request of "alice" again
      Then the step shall show the hint "Check the loop bound."
      And the request shall be resolved as helped by a hint

    Scenario: The hint stays on the step it was asked from
      Given "alice" is signed in and asked for help as "hint"
      When "ellen" answers the request with the hint "Check the loop bound."
      And "alice" moves to the step "03"
      Then the step shall show no hint

  @rule-0398 @ears-event-driven
  Rule: When a request is resolved, tutors shall ask the student once whether it helped and record the answer against the request.

    Scenario: The student says the lecturer's help helped
      Given "alice" is signed in and asked for help as "lecturer"
      When "ellen" resolves the request
      And the reader reads the request of "alice" again
      Then the reader shall ask whether the help helped
      When "alice" answers that it helped
      Then the request shall record that it helped
      And the reader shall not ask again

    Scenario: The student marking it solved is asked too
      Given "alice" is signed in and asked for help as "stuck"
      When "alice" marks the request solved
      Then the reader shall ask whether the help helped

    Scenario: Closing the question without an answer is not asked again
      Given "alice" is signed in and asked for help as "stuck"
      When "ellen" resolves the request
      And the reader reads the request of "alice" again
      And "alice" closes the question
      And the reader reads the request of "alice" once more
      Then the reader shall not ask again
      And the request shall record no answer

  @rule-0399 @ears-ubiquitous
  Rule: Tutors shall hide the help control in anonymous mode and for visitors who are not signed in, and keep the lab usable without it.

    Scenario: A signed-in student is offered the help control
      Given "alice" is signed in to the reader
      When "alice" arrives at the step
      Then the help control shall be offered

    Scenario Outline: The help control is hidden from a visitor who is not signed in, and in anonymous mode
      Given the reader is <mode>
      When a visitor arrives at the step
      Then the help control shall be hidden
      And nothing shall have been asked of the help desk
      And the step's private notes shall still be kept

      Examples:
        | mode                |
        | signed in to nobody |
        | in anonymous mode   |
