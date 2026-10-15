@instructor
Feature: Snippet sharing and lecturer broadcasts
  As an instructor
  I want students to hand me the code they are stuck on, and to speak to the whole class at once
  So that I can see what the room is struggling with and steer it

  A student pastes a snippet from a lab; the reader's server keeps it in `course_gists` for two
  days and publishes a content-free ping on the course's `snippets:<courseId>` topic, which the
  time dashboard's snippet page hears and refreshes on. Only an educator the course's published
  enrollment lists may read the snippets. A lecturer's broadcast goes out through the reader's
  server on `broadcast:<courseId>`, at most once a minute per course, and every student tab
  reading the course shows it once as a toast. Browsers publish nothing on Realtime.

  @rule-0420 @ears-event-driven
  Rule: When a signed-in student shares a snippet from a lab, the reader shall keep it for the course's educators with an expiry 48 hours after it was shared.

    Scenario: A student shares the error they are seeing
      Given "alice" is signed in to the course "cs101"
      When she shares the snippet "TypeError at step3.js:14" named "error.txt" from "Lab 02"
      Then the reader shall keep the snippet for "cs101" as "alice" with the filename "error.txt" and the lab "Lab 02"
      And the snippet shall expire 48 hours after it was shared

  @rule-0421 @ears-unwanted
  Rule: If a student has shared 3 snippets with a course in the last hour, then the reader shall refuse the next share until the hour has passed.

    Scenario: A fourth snippet in the hour is refused
      Given "alice" is signed in to the course "cs101"
      And she has shared 3 snippets in the last hour
      When she shares the snippet "one more" named "more.txt" from "Lab 02"
      Then the reader shall refuse the share as "rate-limited"
      And the reader shall keep 3 snippets for "cs101"

    Scenario: The hour passes
      Given "alice" is signed in to the course "cs101"
      And she has shared 3 snippets in the last hour
      And 61 minutes pass
      When she shares the snippet "one more" named "more.txt" from "Lab 02"
      Then the reader shall keep 4 snippets for "cs101"

  @rule-0422 @ears-unwanted
  Rule: If a shared snippet is empty or larger than 400 kB, then the reader shall refuse the share without keeping anything.

    Scenario: An empty snippet
      Given "alice" is signed in to the course "cs101"
      When she shares the snippet "   " named "empty.txt" from "Lab 02"
      Then the reader shall refuse the share as "empty"
      And the reader shall keep 0 snippets for "cs101"

    Scenario: An oversized snippet
      Given "alice" is signed in to the course "cs101"
      When she shares a snippet of 400001 bytes named "big.txt" from "Lab 02"
      Then the reader shall refuse the share as "too-large"
      And the reader shall keep 0 snippets for "cs101"

  @rule-0423 @ears-event-driven
  Rule: When a snippet is kept, the reader shall publish on the course's snippets topic a notice that carries the course id, a notice id and the time and nothing else.

    Scenario: The ping carries no content
      Given "alice" is signed in to the course "cs101"
      When she shares the snippet "TypeError at step3.js:14" named "error.txt" from "Lab 02"
      Then the reader shall publish one "gist-created" notice for "cs101"
      And the notice shall carry only the fields "courseId, id, sentAt, type"

    Scenario: A refused share publishes nothing
      Given "alice" is signed in to the course "cs101"
      When she shares the snippet "   " named "empty.txt" from "Lab 02"
      Then the reader shall publish no notice

  @rule-0424 @ears-state-driven
  Rule: While a signed-in person is listed as an educator in the course's published enrollment, the time dashboard shall show them the course's snippets that have not expired, newest first.

    @active
    Scenario: An educator reads the room
      Given the course "cs101" is published with the educators "lecturer"
      And these snippets were shared with "cs101":
        | student | snippet | hours ago |
        | alice   | first   | 3         |
        | bob     | second  | 1         |
        | carol   | stale   | 49        |
      When "lecturer" opens the snippets page for "cs101"
      Then the time dashboard shall show the snippets "second, first"

    @inactive
    Scenario: A student is refused
      Given the course "cs101" is published with the educators "lecturer"
      And "alice" shared the snippet "first" with "cs101" 3 hours ago
      When "alice" opens the snippets page for "cs101"
      Then the time dashboard shall refuse with the reason "not-educator"

    @inactive
    Scenario: A course with no enrollment admits nobody
      Given the course "cs101" is published with no enrollment
      When "lecturer" opens the snippets page for "cs101"
      Then the time dashboard shall refuse with the reason "no-enrollment"

    @inactive
    Scenario: A visitor who is not signed in is refused before the course is read
      Given the course "cs101" is published with the educators "lecturer"
      When a visitor who is not signed in opens the snippets page for "cs101"
      Then the time dashboard shall refuse with the reason "anonymous"
      And the course is never read

  @rule-0425 @ears-event-driven
  Rule: When a lecturer broadcasts a message to a course, the reader shall deliver the message with the lecturer's name to every student reading the course.

    Scenario: The quiz is open
      Given "Dr. Smith" is a lecturer of "cs101"
      And "alice" and "bob" are reading "cs101"
      When the lecturer broadcasts "Quiz is open" saying "Head to Lab 02" with the action "Start" to "/cs101/lab-02"
      Then the reader shall publish one "course:broadcast" notice for "cs101"
      And "alice" and "bob" shall each see the toast "Quiz is open" from "Dr. Smith" with the action "Start"

    Scenario: A lecturer with no name is shown as Tutor
      Given "" is a lecturer of "cs101"
      And "alice" and "bob" are reading "cs101"
      When the lecturer broadcasts "Break" saying "Back in 10" with the action "" to ""
      Then "alice" and "bob" shall each see the toast "Break" from "Tutor" with the action ""

  @rule-0426 @ears-unwanted
  Rule: If a course was broadcast to less than 60 seconds ago, then the reader shall refuse the next broadcast to that course.

    Scenario: Two broadcasts in a minute
      Given "Dr. Smith" is a lecturer of "cs101"
      And the lecturer broadcast "Quiz is open" saying "Go" 30 seconds ago
      When the lecturer broadcasts "Quiz is open" saying "Go" with the action "" to ""
      Then the reader shall refuse the broadcast as "rate-limited"

    Scenario: The minute passes
      Given "Dr. Smith" is a lecturer of "cs101"
      And the lecturer broadcast "Quiz is open" saying "Go" 61 seconds ago
      When the lecturer broadcasts "Quiz is open" saying "Go" with the action "" to ""
      Then the reader shall publish one "course:broadcast" notice for "cs101"

    Scenario: Another course is unaffected
      Given "Dr. Smith" is a lecturer of "cs101"
      And the lecturer broadcast "Quiz is open" saying "Go" 30 seconds ago
      When the lecturer broadcasts "Hello" saying "cs102" with the action "" to "" on "cs102"
      Then the reader shall publish one "course:broadcast" notice for "cs102"

  @rule-0427 @ears-ubiquitous
  Rule: The reader shall show a lecturer's broadcast once in each tab, however many times its notice arrives.

    Scenario: A replayed notice
      Given "alice" and "bob" are reading "cs101"
      When the notice "bc-1" from "Dr. Smith" titled "Quiz is open" arrives 3 times
      Then "alice" and "bob" shall each see 1 toast

    Scenario: A broadcast to another course
      Given "alice" and "bob" are reading "cs101"
      When the notice "bc-2" from "Dr. Smith" titled "Elsewhere" arrives for "cs102"
      Then "alice" and "bob" shall each see 0 toasts

  @rule-0428 @ears-state-driven
  Rule: While the reader is composed for anonymous use, the reader shall offer no snippet sharing and hear no broadcast.

    @active
    Scenario: The anonymous reader
      Given the reader is composed for anonymous use
      When "alice" tries to share a snippet with "cs101"
      Then the reader shall offer no snippet sharing
      And a broadcast to "cs101" shall reach no tab

    @inactive
    Scenario: The signed-in reader
      Given the reader is composed with a sign-in
      When "alice" tries to share a snippet with "cs101"
      Then the reader shall offer snippet sharing
      And a broadcast to "cs101" shall reach the tab
