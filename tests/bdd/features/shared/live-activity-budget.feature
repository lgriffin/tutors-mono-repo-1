@shared
Feature: Tutors Live activity through the reader's server
  The reader no longer broadcasts each page view from the browser. It sends the learning event to its
  own server, which publishes it to the course's and the platform's activity topics on Valkey, where
  the Tutors Live tabs streaming them hear it.

  Background:
    Given the course "web-dev-101" is published with 2 labs

  @rule-0330 @ears-event-driven
  Rule: When a student opens a learning object, the reader shall send the learning event to the reader's server without publishing it over Realtime from the browser.

    Scenario: A page view is stored and sent to the reader's server
      Given "Alice" is signed in with sharing enabled
      When the student opens lab 1
      Then the reader's server has received 1 learning event for "Alice"
      And the learning event of "Alice" is stored for Tutors Live
      And the browser has published nothing over Realtime

  @rule-0336 @ears-unwanted
  Rule: If a learning event sent to the reader's server is larger than 4 KB, lacks a course or student id, or has a field over 1000 characters, then the reader shall reject it with status 400.

    Scenario Outline: A malformed learning event is rejected and not published
      When a client sends the reader's server a learning event with "<fault>"
      Then the reader's server answers with status 400
      And the course feed has 0 broadcasts for "Alice"

      Examples:
        | fault               |
        | no course id        |
        | no student id       |
        | a 1001 letter title |
        | a 5000 byte body    |
        | a body that is not JSON |

  @rule-0338 @ears-optional
  Rule: Where anonymous mode is enabled, the reader shall accept learning events at its server without publishing them.

    @active
    Scenario: An anonymous deployment publishes nothing
      Given the reader runs in anonymous mode
      When a client sends the reader's server a learning event for "Alice"
      Then the reader's server answers with status 204
      And the course feed has 0 broadcasts for "Alice"

    @inactive
    Scenario: A signed-in deployment publishes the event
      When a client sends the reader's server a learning event for "Alice"
      Then the reader's server answers with status 202
      And the course feed has 1 broadcasts for "Alice"
