@shared
Feature: Help requests on the reader's server
  As a student asking for help, and a lecturer running a lab
  I want help requests kept and changed only by the reader's server, as the person signed in
  So that nobody can ask, answer or watch the queue as someone else

  Help requests are kept in Postgres (assistance_requests) and their changes travel on Valkey on
  the course's help queue topic. The browser posts to /api/assistance; the reader's server runs the
  Assistance use cases as the session's actor. Tutors Live's course page reads and streams the
  queue from the reader's origin with the lecturer's session. These Rules drive the reader's routes
  over a Postgres database (PGlite) and the process's memory hub, which stands in for Valkey.

  Background:
    Given the course "cs101" is published with 2 labs and "ellen" as its educator

  @rule-0390 @ears-ubiquitous
  Rule: Tutors shall accept a help request, acknowledgement or resolution only on the reader's server from the signed-in actor, refusing a visitor who is not signed in with 401 and a student acting as the lecturer with 403.

    Scenario: A signed-in student's request is kept as theirs
      Given "alice" is signed in to the reader
      When the browser asks for help as "stuck" on the step "02" of the first lab
      Then the reader shall answer 201
      And Postgres shall hold one "open" help request by "alice" at the step "02" of the first lab of kind "stuck"

    Scenario: A visitor who is not signed in is refused
      Given nobody is signed in to the reader
      When the browser asks for help as "stuck" on the step "02" of the first lab
      Then the reader shall answer 401
      And Postgres shall hold no help request

    Scenario: A student cannot acknowledge as the lecturer
      Given "alice" has asked for help as "stuck" on the step "02" of the first lab
      And "bob" is signed in to the reader
      When the browser acknowledges the request of "alice"
      Then the reader shall answer 403
      And Postgres shall hold one "open" help request by "alice" at the step "02" of the first lab of kind "stuck"

    Scenario: The course's educator acknowledges from Tutors Live
      Given "alice" has asked for help as "stuck" on the step "02" of the first lab
      And "ellen" is signed in to the reader
      When Tutors Live acknowledges the request of "alice" with the session
      Then the reader shall answer 200
      And Postgres shall hold one "acknowledged" help request by "alice" at the step "02" of the first lab of kind "stuck"
      And the request shall record it was acknowledged by "ellen"

  @rule-0391 @ears-event-driven
  Rule: When a help request changes state, tutors shall publish the changed request on the course's help queue topic once it is stored.

    Scenario: An educator watching the queue hears a request open and be acknowledged
      Given "ellen" is streaming the help queue of "cs101" from Tutors Live
      And "alice" has asked for help as "lecturer" on the step "02" of the first lab
      When "ellen" acknowledges the request of "alice"
      Then the stream shall carry the request of "alice" as "open", then as "acknowledged"

    Scenario: A refused change publishes nothing
      Given "ellen" is streaming the help queue of "cs101" from Tutors Live
      And "alice" has asked for help as "stuck" on the step "02" of the first lab
      When "bob" acknowledges the request of "alice"
      Then the stream shall carry the request of "alice" as "open" and nothing more

  @rule-0392 @ears-ubiquitous
  Rule: Tutors shall give a course's help queue, streamed or read, only to a signed-in educator of the course, and give a student only their own live request, read from stored rows.

    Scenario: The educator reads the queue from Tutors Live
      Given "alice" has asked for help as "stuck" on the step "02" of the first lab
      And "ellen" is signed in to the reader
      When Tutors Live reads the help queue of "cs101" with the session
      Then the queue shall hold the request of "alice" at the step "02" of the first lab

    Scenario: A student cannot stream the queue
      Given "bob" is signed in to the reader
      When Tutors Live streams the help queue of "cs101" with the session
      Then the reader shall answer 403

    Scenario: A student cannot read the queue
      Given "bob" is signed in to the reader
      When Tutors Live reads the help queue of "cs101" with the session
      Then the reader shall answer 403

    Scenario: A student reads their own request
      Given "alice" has asked for help as "hint" on the step "02" of the first lab
      When "alice" reads their own help request in "cs101"
      Then the answer shall be the request of "alice" of kind "hint"

    Scenario: A student never reads another student's request
      Given "alice" has asked for help as "hint" on the step "02" of the first lab
      When "bob" reads their own help request in "cs101"
      Then the answer shall be no request

  @rule-0394 @ears-unwanted
  Rule: If the assistance store is unreachable when a student asks for help, then tutors shall answer that the request was not sent, and record and publish nothing.

    Scenario: The database is down
      Given "ellen" is streaming the help queue of "cs101" from Tutors Live
      And the Postgres database is unreachable
      And "alice" is signed in to the reader
      When the browser asks for help as "stuck" on the step "02" of the first lab
      Then the reader shall answer 503 saying the help request was not sent
      And the stream shall carry nothing
