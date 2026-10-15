Feature: Live activity pipeline
  As a lecturer watching the live dashboard
  I want sessions, views and presence counted from anonymous events
  So that I can see how a course is used without anyone having to sign in

  @rule-0420 @ears-event-driven
  Rule: When a reader posts a batch of live events, the live dashboard shall publish every event that passes validation and report each rejected event with its reason.

    Scenario: A batch with one malformed event loses only that event
      Given the live dashboard runs on the in-memory bus
      When a reader posts a batch of 2 valid events and 1 event of type "session.hijacked"
      Then the bus carries 2 events
      And the batch is reported as 2 accepted and 1 rejected for "unknown type: session.hijacked"

    Scenario: A batch with nothing to believe is refused
      Given the live dashboard runs on the in-memory bus
      When a reader posts a batch of 0 valid events and 1 event of type "nonsense"
      Then the bus carries 0 events
      And the batch is reported as 0 accepted and 1 rejected for "unknown type: nonsense"

  @rule-0421 @ears-unwanted
  Rule: If a live session sends no event for 30 minutes, then the live dashboard shall close the session with the duration up to its last event.

    Scenario: The sweeper closes a session a closed laptop never ended
      Given the live dashboard ingests events for the course "cs101"
      When the session "s1" opens the course at "2026-09-17T10:00:00.000Z" and sends a heartbeat at "2026-09-17T10:05:00.000Z"
      And the sweeper runs at "2026-09-17T10:36:00.000Z"
      Then the warehouse holds 1 completed session for "cs101" lasting 300 seconds

    Scenario: A session that is still talking stays open
      Given the live dashboard ingests events for the course "cs101"
      When the session "s1" opens the course at "2026-09-17T10:00:00.000Z" and sends a heartbeat at "2026-09-17T10:05:00.000Z"
      And the sweeper runs at "2026-09-17T10:20:00.000Z"
      Then the warehouse holds 0 completed sessions for "cs101"

  @rule-0422 @ears-ubiquitous
  Rule: The live dashboard shall count a session as active only while its last event is within the 2-minute presence window.

    Scenario: A session goes quiet and leaves the Now panel
      Given the live dashboard ingests events for the course "cs101"
      When the session "s1" opens the course at "2026-09-17T10:00:00.000Z" and sends a heartbeat at "2026-09-17T10:01:00.000Z"
      Then the Now panel at "2026-09-17T10:02:30.000Z" shows 1 active session on "cs101"
      And the Now panel at "2026-09-17T10:03:30.000Z" shows 0 active sessions on "cs101"

  @rule-0423 @ears-state-driven
  Rule: While a learner has not opted in, the reader shall report live events that carry the rotating session token and no identifier.

    @active
    Scenario: An anonymous reader is counted without an identity
      Given a reader pointed at the live dashboard's ingest endpoint
      When the reader opens the course "cs101" and the lab "/topic-1/lab-1"
      Then the reader queues the events "session.started, course.opened, lo.viewed, service.used" for "cs101"
      And none of the queued events carries an identifier

    @inactive
    Scenario: A learner who opted in is counted under a hash, never a login
      Given a reader pointed at the live dashboard's ingest endpoint
      And the signed-in learner "aoife" has opted in
      When the reader opens the course "cs101" and the lab "/topic-1/lab-1"
      Then the session start carries a 32-character identifier that is not "aoife"

  @rule-0424 @ears-ubiquitous
  Rule: The live dashboard shall report, for the selected range, the completed sessions, the views and the median session length of that range only.

    Scenario: Yesterday's session is in the 7-day stats
      Given the warehouse holds a 600-second session on "cs101" with 3 views 1 day ago and a 1200-second session on "cs101" with 1 view 10 days ago
      When the stats for the range "7d" are read
      Then the stats show 1 session, 3 views and a median session length of 600 seconds

    Scenario: Yesterday's session is not in today's stats
      Given the warehouse holds a 600-second session on "cs101" with 3 views 1 day ago and a 1200-second session on "cs101" with 1 view 10 days ago
      When the stats for the range "today" are read
      Then the stats show 0 sessions, 0 views and a median session length of 0 seconds
