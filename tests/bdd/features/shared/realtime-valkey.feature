Feature: Realtime on Valkey
  As the team running Tutors
  I want the reader and Live servers to carry realtime themselves, over Valkey and server-sent events
  So that presence, course notices, live shares and shared whiteboards need no hosted broker and no daily message budget

  Background:
    Given the course "web-dev-101" is published with 2 labs and "eve" as its educator

  @rule-0481 @ears-ubiquitous
  Rule: The reader shall publish each learning event it receives to the course's and the platform's activity topics on Valkey, without claiming a daily Live budget.

    Scenario: A page view reaches the course and platform feeds
      Given a browser streams the activity of "web-dev-101" from the reader
      And a browser streams the platform's activity from the reader
      When the reader posts the learning event of "Alice" opening the first lab
      Then the reader answers 202 with the tier "normal" and both activity topics
      And the course stream receives the learning event of "Alice"
      And the platform stream receives the learning event of "Alice"
      And the store was not queried

  @rule-0482 @ears-event-driven
  Rule: When a browser opens the realtime stream of a topic on the reader's or Tutors Live's server, tutors shall send each message published to that topic as a server-sent event until the browser closes the stream.

    Scenario: A lecturer's broadcast reaches a reader tab's stream
      Given "eve" is signed in to the reader
      And a browser streams the broadcasts of "web-dev-101" from the reader
      When "eve" broadcasts "Lab 2 is open" to "web-dev-101"
      Then the broadcast stream receives the broadcast "Lab 2 is open"

    Scenario: Tutors Live's server streams what the reader's server published
      Given a Live tab streams the activity of "web-dev-101" from Tutors Live's server
      When the reader posts the learning event of "Alice" opening the first lab
      Then the Live tab's stream receives the learning event of "Alice"

    Scenario: A closed stream receives nothing more
      Given a browser streams the activity of "web-dev-101" from the reader
      When the browser closes the stream
      And the reader posts the learning event of "Alice" opening the first lab
      Then nothing listens to the activity of "web-dev-101" any more

  @rule-0483 @ears-unwanted
  Rule: If a browser asks for the realtime stream of a topic Tutors does not publish, then the reader shall answer 400 and subscribe to nothing.

    Scenario: An unknown topic is refused
      When a browser asks the reader for the stream of the topic "../admin"
      Then the reader answers 400
      And nothing listens to the topic "../admin"

  @rule-0484 @ears-unwanted
  Rule: If a browser asks the reader's server to publish to a topic other than a playground share or a shared whiteboard's room, an event that topic does not take, or as anyone but the signed-in student, educator or editor the event names, then the reader shall answer 400, 401 or 403 and publish nothing.

    Scenario: A browser cannot publish a lecturer's broadcast
      Given "eve" streams the broadcasts of "web-dev-101" from the reader
      When "alice" asks the reader to publish "course-broadcast" on "broadcast:web-dev-101"
      Then the reader answers 403
      And the broadcast stream receives nothing

    Scenario: A playground share's state reaches the lecturer's stream
      Given "eve" streams the playground share of the first lab of "web-dev-101" from the reader
      When "alice" asks the reader to publish "state" for "alice" on the playground share of the first lab
      Then the reader answers 202
      And the playground stream receives the state of "alice"

    Scenario: A browser cannot publish another event on a playground share
      Given "eve" streams the playground share of the first lab of "web-dev-101" from the reader
      When "alice" asks the reader to publish "course-broadcast" for "alice" on the playground share of the first lab
      Then the reader answers 400
      And the playground stream receives nothing

    Scenario: A signed-out browser cannot publish
      Given "eve" streams the playground share of the first lab of "web-dev-101" from the reader
      When a signed-out browser asks the reader to publish "state" for "alice" on the playground share of the first lab
      Then the reader answers 401
      And the playground stream receives nothing

    Scenario: A student cannot share another student's work
      Given "eve" streams the playground share of the first lab of "web-dev-101" from the reader
      When "mallory" asks the reader to publish "state" for "alice" on the playground share of the first lab
      Then the reader answers 403
      And the playground stream receives nothing

    Scenario: A student cannot announce they are watching
      Given "alice" streams the playground share of the first lab of "web-dev-101" from the reader
      When "mallory" asks the reader to publish "watching" for "mallory" on the playground share of the first lab
      Then the reader answers 403
      And the playground stream receives nothing

    Scenario: An editor cannot move someone else's cursor on a shared whiteboard
      Given "bob" streams the shared whiteboard of the first lab of "web-dev-101" from the reader
      When "mallory" asks the reader to publish "cursor-update" for "alice" on the shared whiteboard of the first lab
      Then the reader answers 403
      And the whiteboard stream receives nothing

    Scenario: A browser cannot publish another event on a shared whiteboard
      Given "bob" streams the shared whiteboard of the first lab of "web-dev-101" from the reader
      When "alice" asks the reader to publish "state" for "alice" on the shared whiteboard of the first lab
      Then the reader answers 400
      And the whiteboard stream receives nothing

  @rule-0560 @ears-event-driven
  Rule: When a browser that is not signed in as an educator of the course streams a playground share, the reader shall send it only the lecturers' watching announcements.

    Scenario: A sharing student hears the lecturer watching but sees no one's work
      Given "alice" streams the playground share of the first lab of "web-dev-101" from the reader
      When "bob" asks the reader to publish "state" for "bob" on the playground share of the first lab
      And "eve" asks the reader to publish "watching" for "eve" on the playground share of the first lab
      Then the playground stream receives only the watching announcement

    Scenario: A signed-out browser cannot stream a playground share
      When a signed-out browser asks the reader for the stream of the playground share of the first lab
      Then the reader answers 401
      And nothing listens to the playground share

  @rule-0485 @ears-unwanted
  Rule: If a browser's realtime stream fails, then tutors shall close the stream and reopen it after the realtime gateway's full-jitter backoff instead of the browser's own fixed retry.

    Scenario: A failed stream is reopened after the gateway's backoff
      Given a reader tab whose realtime gateway streams over server-sent events with a random draw of 0.5
      And the tab streams the broadcasts of "web-dev-101"
      When the stream fails
      Then the failed stream is closed
      And no stream is reopened before 500 ms
      And one stream is reopened at 500 ms

  @rule-0580 @ears-ubiquitous
  Rule: The reader shall carry each shared whiteboard room's scene changes, cursors, presence and leaving between the browsers streaming it, from editors who are signed in.

    Scenario: A scene change reaches the other editors of a shared whiteboard
      Given "bob" streams the shared whiteboard of the first lab of "web-dev-101" from the reader
      When "alice" asks the reader to publish "scene-update" for "alice" on the shared whiteboard of the first lab
      Then the reader answers 202
      And the whiteboard stream receives the "scene-update" of "alice"'s tab

    Scenario: An editor's presence reaches the other editors of a shared whiteboard
      Given "bob" streams the shared whiteboard of the first lab of "web-dev-101" from the reader
      When "alice" asks the reader to publish "presence" for "alice" on the shared whiteboard of the first lab
      Then the reader answers 202
      And the whiteboard stream receives the "presence" of "alice"'s tab

