@instructor
Feature: The help queue in Tutors Live
  As a lecturer running a lab
  I want the course's help queue on the course's page in Tutors Live
  So that I see who is waiting, where and for how long, and get to them in order

  The queue is helpQueueService in svelte-state and HelpQueue on Tutors Live's course page. It reads
  the queue from stored rows through the HelpDesk (the reader's GET /api/assistance, educators only)
  and hears changes on the course's stream where one is composed (Valkey, Rule 0391). These Rules
  drive helpQueueService over the in-memory help desk and feed.

  Background:
    Given "ellen" teaches the course "cs101" and opens its help queue in Tutors Live at "2026-01-05T09:00:00.000Z"

  @rule-0393 @ears-ubiquitous
  Rule: Tutors shall read a lecturer's help queue from stored rows every 60 seconds, show between reads each change the queue's stream brings, and keep the last queue on screen when a read fails.

    Scenario: Without a stream a new request shows at the next read
      Given the help queue has no stream
      When "alice" asks for help as "stuck" on the step "02" of the lab "/lab/cs101/lab-01"
      Then the queue shall show no request
      When 60 seconds pass
      Then the queue shall show the request of "alice"

    Scenario: With a stream a new request shows at once
      Given the help queue is streamed
      When "alice" asks for help as "stuck" on the step "02" of the lab "/lab/cs101/lab-01"
      Then the queue shall show the request of "alice"

    Scenario: A read that fails keeps the last queue
      Given "alice" asks for help as "stuck" on the step "02" of the lab "/lab/cs101/lab-01"
      And 60 seconds pass
      When the help requests cannot be read
      And 60 more seconds pass
      Then the queue shall show the request of "alice"
      And the queue shall say it was last read at "2026-01-05T09:01:00.000Z"

  @rule-0395 @ears-ubiquitous
  Rule: Tutors shall show a lecturer, for each open request, the student's name, the lab and step, the kind of help, the waiting time updating each second, and whether the student is still online.

    Scenario: A request shows who, where, what and how long, and the time moves
      Given the help queue is streamed
      And "alice" is online on the course
      When "alice" asks for help as "hint" on the step "02" of the lab "/lab/cs101/lab-01"
      And 3 seconds pass
      Then the queue's row shall show "ALICE", the lab "/lab/cs101/lab-01", the step "02" and the kind "hint"
      And the row shall have waited 3 seconds
      And the row shall show the student online
      When 1 second passes
      Then the row shall have waited 4 seconds

    Scenario: A student who left the course shows offline
      Given the help queue is streamed
      When "bob" asks for help as "stuck" on the step "01" of the lab "/lab/cs101/lab-01"
      Then the row shall show the student offline

  @rule-0396 @ears-ubiquitous
  Rule: Tutors shall order the help queue by lecturer requests first, then by waiting time, longest first.

    Scenario: Lecturer requests lead, then the longest waiting
      Given the help queue is streamed
      When "alice" asks for help as "stuck" on the step "02" of the lab "/lab/cs101/lab-01"
      And 10 seconds pass
      And "bob" asks for help as "hint" on the step "03" of the lab "/lab/cs101/lab-01"
      And 10 more seconds pass
      And "carol" asks for help as "lecturer" on the step "01" of the lab "/lab/cs101/lab-01"
      Then the queue shall list "carol", "alice", "bob" in that order

  @rule-0563 @ears-unwanted
  Rule: If a request's stored lab or step is not valid URL-encoded text, then tutors shall show it in the help queue as stored.

    Scenario: A malformed step shows as stored
      Given the help queue is streamed
      When "alice" asks for help as "stuck" on the step "50%off" of the lab "/lab/cs101/100%"
      Then the queue's row shall name the lab "100%" and the step "50%off"

    Scenario: An encoded step shows decoded
      Given the help queue is streamed
      When "alice" asks for help as "stuck" on the step "step%2002" of the lab "/lab/cs101/lab%2001"
      Then the queue's row shall name the lab "lab 01" and the step "step 02"

  @rule-0407 @ears-event-driven
  Rule: When a lecturer resolves a help request in the help queue, the live dashboard shall offer to turn it into an explanation for everyone on the request's step, pre-filled with that step and any hint.

    Scenario: An answered hint becomes an explanation for everyone on the step
      Given the help queue is streamed
      And "alice" asks for help as "hint" on the step "02" of the lab "/lab/cs101/lab-01"
      When "ellen" answers the request of "alice" with the hint "Check the loop bound."
      Then the queue shall offer an explanation for the step "02" of the lab "/lab/cs101/lab-01" starting "Check the loop bound."
      When "ellen" posts the explanation
      Then everyone on the step "02" of the lab "/lab/cs101/lab-01" shall have the explanation "Check the loop bound."
      And the queue shall say an explanation was posted on the step "02"
      And the queue shall offer no explanation

    Scenario: A lecturer who passes posts nothing
      Given the help queue is streamed
      And "alice" asks for help as "stuck" on the step "02" of the lab "/lab/cs101/lab-01"
      When "ellen" resolves the request of "alice"
      Then the queue shall offer an explanation for the step "02" of the lab "/lab/cs101/lab-01" starting ""
      When "ellen" passes on the explanation
      Then the queue shall offer no explanation
      And nothing shall have been broadcast on the course
