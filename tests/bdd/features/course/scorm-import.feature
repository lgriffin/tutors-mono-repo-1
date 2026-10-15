@course
Feature: SCORM Import
  As an instructor
  I want to drop a vendor's SCORM package into my course
  So that published content sits alongside my own learning objects

  Background:
    Given a course folder holding an unpacked SCORM 1.2 package, a vendor zip and an empty scorm folder

  @rule-0438 @ears-ubiquitous
  Rule: tutors shall recognise scorm as a simple learning object type with an icon and a colour in every theme.

    Scenario: A scorm folder is a first-class learning object type
      Then scorm is a simple learning object type with a place in the ordering
      And every icon library gives scorm an icon and a colour
      And the generator's templates give scorm an icon and a colour

  @rule-0439 @ears-event-driven
  Rule: When a course is built from a folder holding an unpacked SCORM package, tutors shall read the version, launch file, title and mastery score into the learning object.

    Scenario: An unpacked package becomes a learning object
      When the course is built
      Then the "scorm-quiz" learning object declares SCORM version "1.2"
      And the "scorm-quiz" learning object launches "shared/launch.html" from inside its package folder
      And the "scorm-quiz" learning object is titled "Try the Quiz" by its author rather than its package
      And the "scorm-quiz" learning object has a mastery score of 60

  @rule-0440 @ears-event-driven
  Rule: When a course is built from a folder holding only the vendor's zip, tutors shall read the manifest from inside the zip and unpack the package into the generated course.

    Scenario: A vendor zip is accepted exactly as downloaded
      When the course is built
      And the course's assets are copied to the output folder
      Then the "scorm-packed" learning object declares SCORM version "2004"
      And the "scorm-packed" learning object launches "start.html" from inside its package folder
      And the "scorm-packed" learning object is titled "Vendor Module" after its package
      And the output holds "start.html" and "assets/module.css" inside the "scorm-packed" package folder

  @rule-0441 @ears-ubiquitous
  Rule: tutors shall publish an imported package's files once, in a package folder beneath the learning object, beside the card image and without the author's markdown or the vendor zip.

    Scenario: Package files are published beneath the learning object
      When the course's assets are copied to the output folder
      Then the output holds "imsmanifest.xml", "shared/launch.html" and "shared/quiz.js" inside the "scorm-quiz" package folder
      And the output leaves "index.html" and "vendor.zip" out of the "scorm-packed" learning object folder
      And the output holds "player.js" inside the "scorm-quiz" package folder and not in the learning object folder
      And the output leaves "scorm-quiz.md" out of the "scorm-quiz" package folder
      And the output holds "scorm-quiz.png" in the "scorm-quiz" learning object folder

  @rule-0442 @ears-ubiquitous
  Rule: The reader shall frame an imported package from its own origin and pass through only files inside a package folder on a public host.

    Scenario: The package is framed from the reader's own origin
      Then the package address "https://course.netlify.app/topic-01/scorm-quiz/package/shared/launch.html" is framed as "/scorm-content/course.netlify.app/topic-01/scorm-quiz/package/shared/launch.html"
      And the path "topic-01/scorm-quiz/package/shared/launch.html" on "course.netlify.app" is passed through
      And the path "tutors.json" on "course.netlify.app" is refused
      And the private host "169.254.169.254" is refused for "topic-01/scorm-quiz/package/launch.html"

  @rule-0443 @ears-state-driven
  Rule: While a learner has a suspended attempt at an imported package, the reader shall report the attempt to the content as resumable with its saved bookmark.

    @active
    Scenario: A learner resumes where they left off
      Given a learner's saved attempt is suspended at "question-4" with suspend data "answers=3"
      When the content initialises the SCORM 1.2 run-time
      Then the content reads "cmi.core.entry" as "resume"
      And the content reads the bookmark "cmi.core.lesson_location" as "question-4" and "cmi.suspend_data" as "answers=3"
      And the run-time is taken down

    @inactive
    Scenario: A first attempt starts from the beginning
      Given a learner has no saved attempt
      When the content initialises the SCORM 1.2 run-time
      Then the content reads "cmi.core.entry" as "ab-initio"
      And the content reads the bookmark "cmi.core.lesson_location" as "" and "cmi.suspend_data" as ""
      And the run-time is taken down

  @rule-0444 @ears-unwanted
  Rule: If the browser denies the reader storage, then the reader shall keep a SCORM attempt in memory for the session.

    Scenario: Private browsing keeps the attempt for the session
      Given the browser denies storage
      When the run-time saves a bookmark of "question-4"
      Then the run-time reads the bookmark "question-4" back

  @rule-0445 @ears-unwanted
  Rule: If a scorm folder holds no manifest and no zip, then tutors shall continue the build with that learning object left without a launch address.

    Scenario: A folder with no manifest is reported, not fatal
      When the course is built
      Then the course holds the "scorm-empty" learning object
      And the "scorm-empty" learning object has no launch address

  @rule-0446 @ears-unwanted
  Rule: If a zip entry names a path outside the destination folder, then tutors shall skip that entry.

    Scenario: A malicious archive cannot escape the output folder
      Given a zip whose entries are "index.html" and "../escaped.txt"
      When the zip is unpacked
      Then "index.html" is written into the destination
      And "escaped.txt" is not written beside it
