@instructor
Feature: SCORM Export
  As an instructor whose institution mandates LMS delivery
  I want to package a Tutors course as a SCORM zip
  So that my students can take the course inside Moodle, Canvas or Blackboard

  Background:
    Given an instructor has authored the course "Smoke Course"

  @rule-0447 @ears-event-driven
  Rule: When a course is exported as SCORM 1.2, tutors shall write the manifest in the SCORM 1.2 profile.

    Scenario: SCORM 1.2 packages use the 1.2 profile
      When the course is exported as SCORM "1.2"
      Then the manifest declares schema version "1.2"
      And the manifest uses the content packaging namespace "http://www.imsproject.org/xsd/imscp_rootv1p1p2" with ADL namespace "http://www.adlnet.org/xsd/adlcp_rootv1p2"
      And the manifest spells the SCO attribute "adlcp:scormtype" and not "adlcp:scormType"

  @rule-0448 @ears-event-driven
  Rule: When a course is exported as SCORM 2004, tutors shall write the manifest in the SCORM 2004 4th Edition profile with completion set by the content.

    Scenario: SCORM 2004 packages use the 2004 profile
      When the course is exported as SCORM "2004"
      Then the manifest declares schema version "2004 4th Edition"
      And the manifest uses the content packaging namespace "http://www.imsglobal.org/xsd/imscp_v1p1" with ADL namespace "http://www.adlnet.org/xsd/adlcp_v1p3"
      And the manifest spells the SCO attribute "adlcp:scormType" and not "adlcp:scormtype"
      And the manifest declares that the content sets its own completion

  @rule-0449 @ears-ubiquitous
  Rule: tutors shall list every packaged file once as a file of the launchable resource in the manifest.

    Scenario: Every packaged file is declared
      When the course is exported with the files "index.html, scorm-runtime.js, content/topic-01/index.html"
      Then the manifest lists each of "index.html, scorm-runtime.js, content/topic-01/index.html" as a file of the resource
      And the manifest lists "index.html" exactly once

  @rule-0450 @ears-ubiquitous
  Rule: tutors shall escape the course title in the manifest rather than emit invalid XML.

    Scenario: Course titles are safe in XML
      When the course titled "Maths & <Physics>" is exported
      Then the manifest carries the title as "Maths &amp; &lt;Physics&gt;"
      And the manifest holds no raw "<Physics>"

  @rule-0451 @ears-event-driven
  Rule: When a learner has visited every page of a packaged course, tutors shall report the course to the LMS as completed with full progress.

    Scenario: Completion is reported once the whole course has been seen
      Given a packaged course of 8 pages in a SCORM "2004" LMS
      When the learner visits every page
      Then the LMS holds "cmi.completion_status" as "completed"
      And the LMS holds "cmi.progress_measure" as "1.0000"

    Scenario: A SCORM 1.2 LMS hears the same
      Given a packaged course of 8 pages in a SCORM "1.2" LMS
      When the learner visits every page
      Then the LMS holds "cmi.core.lesson_status" as "completed"

  @rule-0452 @ears-event-driven
  Rule: When a learner leaves a packaged course, tutors shall report the session time in the format the LMS profile requires.

    Scenario: Session time in the SCORM 1.2 format
      Given a packaged course of 1 pages in a SCORM "1.2" LMS
      When the learner leaves after 65 seconds
      Then the LMS holds "cmi.core.session_time" as "00:01:05.00"

    Scenario: Session time in the SCORM 2004 format
      Given a packaged course of 1 pages in a SCORM "2004" LMS
      When the learner leaves after 65 seconds
      Then the LMS holds "cmi.session_time" as "PT1M5S"

  @rule-0453 @ears-state-driven
  Rule: While a learner has visited only part of a packaged course, tutors shall report the attempt as incomplete and suspend it with the visited pages kept when the learner leaves.

    @active
    Scenario: Partial progress is reported as incomplete
      Given a packaged course of 8 pages in a SCORM "1.2" LMS
      When the learner visits pages 0 to 2 and leaves
      Then the LMS holds "cmi.core.lesson_status" as "incomplete"
      And the LMS holds "cmi.core.exit" as "suspend"
      And the attempt is terminated
      And a resumed attempt finishes after visiting pages 3 to 7

    Scenario: A 2004 LMS hears the progress measure
      Given a packaged course of 8 pages in a SCORM "2004" LMS
      When the learner visits pages 0 to 2 and leaves
      Then the LMS holds "cmi.completion_status" as "incomplete"
      And the LMS holds "cmi.progress_measure" as "0.3750"

    @inactive
    Scenario: A finished course ends the attempt
      Given a packaged course of 8 pages in a SCORM "1.2" LMS
      When the learner visits every page and leaves
      Then the LMS holds "cmi.core.lesson_status" as "completed"
      And the LMS holds "cmi.core.exit" as ""

  @rule-0454 @ears-state-driven
  Rule: While a learner has a suspended attempt with a saved location, tutors shall reopen the packaged course at the page the learner left.

    @active
    Scenario: A resumed attempt reopens where the learner left off
      Given a packaged course of 8 pages in a SCORM "1.2" LMS
      And the learner left at page 2, "topic-01/unit-02.html"
      When the learner returns to the package
      Then the package opens "content/topic-01/unit-02.html"

    @inactive
    Scenario: A first attempt opens the entry page
      Given a packaged course of 8 pages in a SCORM "1.2" LMS
      When the learner returns to the package
      Then the package leaves the entry page as written

  @rule-0455 @ears-optional
  Rule: Where a course declares a scorm version in its properties, tutors shall export only that profile with the declared identifier.

    @active
    Scenario: The exported profile is configurable
      Given the course's properties declare scorm version "1.2" and identifier "MY-COURSE"
      When the course's export profiles are read
      Then the course exports the profiles "1.2"
      And the manifest carries the identifier "MY-COURSE"

    Scenario: A numeric version is read as the 2004 profile
      Given the course's properties declare scorm version 2004
      When the course's export profiles are read
      Then the course exports the profiles "2004"

    @inactive
    Scenario: Both profiles are exported when no version is declared
      Given the course's properties declare no scorm version
      When the course's export profiles are read
      Then the course exports the profiles "1.2, 2004"

  @rule-0456 @ears-unwanted
  Rule: If a learner's saved progress is unreadable or was recorded against a different page count, then tutors shall treat the progress as unset.

    Scenario: Republishing must not misreport existing learners
      Given a packaged course of 8 pages in a SCORM "2004" LMS
      And the learner visited pages 0 to 2 and left
      When the course is republished with 9 pages and the learner returns
      Then the LMS holds "cmi.progress_measure" as "0.0000"
      And the LMS holds "cmi.completion_status" as "incomplete"
      And the saved progress is re-encoded for 9 pages

    Scenario: Unreadable saved progress is unset
      Given a packaged course of 8 pages in a SCORM "1.2" LMS whose saved progress reads "not-a-bitfield"
      Then the LMS holds "cmi.core.lesson_status" as "incomplete"
