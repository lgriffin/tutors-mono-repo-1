import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { buildManifest } from "../../../../packages/jsr/gen/src/scorm/manifest";
import { loadPropertyFlags } from "../../../../packages/domain/src/course/utils/course-utils";
import type { Course } from "../../../../packages/domain/src/course/types/learning-objects";
import { launchScormRuntime, type ScormExportHarness } from "../../../support/scorm-runtime-harness";

const feature = await loadFeature("tests/bdd/features/instructor/scorm-export.feature");

const list = (csv: string) => csv.split(",").map((item) => item.trim());

/** Course whose only interesting property is the scorm block from properties.yaml. */
function courseWithProperties(properties: Record<string, unknown>): Course {
  const built = { title: "Smoke Course", courseId: "smoke", id: "smoke", los: [], properties } as unknown as Course;
  loadPropertyFlags(built);
  return built;
}

describeFeature(feature, ({ Background, Rule }) => {
  let course: Course;
  let manifest: string;
  let harness: ScormExportHarness;
  let version: "1.2" | "2004";
  let totalPages: number;
  let declared: Course;

  Background(({ Given }) => {
    Given("an instructor has authored the course {string}", (_ctx, title: string) => {
      course = { title, courseId: "smoke", id: "smoke" } as Course;
    });
  });

  const packaged = (_ctx: unknown, pages: number, lms: string) => {
    version = lms as "1.2" | "2004";
    totalPages = pages;
    harness = launchScormRuntime({ version, totalPages });
  };
  const visitsEvery = () => {
    for (let page = 0; page < totalPages; page += 1) harness.visit(page, `page-${page}.html`);
  };
  const visitsSomeAndLeaves = (_ctx: unknown, from: number, to: number) => {
    for (let page = from; page <= to; page += 1) harness.visit(page, `page-${page}.html`);
    harness.pagehide();
  };
  const lmsHolds = (_ctx: unknown, element: string, value: string) => expect(harness.lms.cmi[element]).toBe(value);
  const lmsAlsoHolds = lmsHolds;
  const exported = (_ctx: unknown, profile: string) => {
    manifest = buildManifest(course, ["index.html"], { version: profile as "1.2" | "2004" });
  };
  const declaresSchema = (_ctx: unknown, schema: string) => expect(manifest).toContain(`<schemaversion>${schema}</schemaversion>`);
  const usesNamespaces = (_ctx: unknown, packaging: string, adl: string) => {
    expect(manifest).toContain(`xmlns="${packaging}"`);
    expect(manifest).toContain(`xmlns:adlcp="${adl}"`);
  };
  const spellsAttribute = (_ctx: unknown, spelt: string, notSpelt: string) => {
    expect(manifest).toContain(`${spelt}="sco"`);
    expect(manifest).not.toContain(`${notSpelt}=`);
  };
  const readsProfiles = () => {
    // The profiles are read when the flags are loaded; nothing further to do.
    expect(declared).toBeDefined();
  };
  const exportsProfiles = (_ctx: unknown, profiles: string) => expect(declared.scormVersions).toEqual(list(profiles));

  Rule("When a course is exported as SCORM 1.2, tutors shall write the manifest in the SCORM 1.2 profile.", ({ RuleScenario }) => {
    RuleScenario("SCORM 1.2 packages use the 1.2 profile", ({ When, Then, And }) => {
      When("the course is exported as SCORM {string}", exported);
      Then("the manifest declares schema version {string}", declaresSchema);
      And("the manifest uses the content packaging namespace {string} with ADL namespace {string}", usesNamespaces);
      And("the manifest spells the SCO attribute {string} and not {string}", spellsAttribute);
    });
  });

  Rule("When a course is exported as SCORM 2004, tutors shall write the manifest in the SCORM 2004 4th Edition profile with completion set by the content.", ({ RuleScenario }) => {
    RuleScenario("SCORM 2004 packages use the 2004 profile", ({ When, Then, And }) => {
      When("the course is exported as SCORM {string}", exported);
      Then("the manifest declares schema version {string}", declaresSchema);
      And("the manifest uses the content packaging namespace {string} with ADL namespace {string}", usesNamespaces);
      And("the manifest spells the SCO attribute {string} and not {string}", spellsAttribute);
      And("the manifest declares that the content sets its own completion", () => {
        expect(manifest).toContain(`completionSetByContent="true"`);
      });
    });
  });

  Rule("tutors shall list every packaged file once as a file of the launchable resource in the manifest.", ({ RuleScenario }) => {
    RuleScenario("Every packaged file is declared", ({ When, Then, And }) => {
      When("the course is exported with the files {string}", (_ctx, files: string) => {
        manifest = buildManifest(course, list(files), { version: "1.2" });
      });
      Then("the manifest lists each of {string} as a file of the resource", (_ctx, files: string) => {
        list(files).forEach((file) => expect(manifest).toContain(`<file href="${file}" />`));
      });
      And("the manifest lists {string} exactly once", (_ctx, file: string) => {
        expect(manifest.match(new RegExp(`<file href="${file.replace(".", "\\.")}" />`, "g"))).toHaveLength(1);
      });
    });
  });

  Rule("tutors shall escape the course title in the manifest rather than emit invalid XML.", ({ RuleScenario }) => {
    RuleScenario("Course titles are safe in XML", ({ When, Then, And }) => {
      When("the course titled {string} is exported", (_ctx, title: string) => {
        manifest = buildManifest({ ...course, title }, [], { version: "1.2" });
      });
      Then("the manifest carries the title as {string}", (_ctx, escaped: string) => {
        expect(manifest).toContain(escaped);
      });
      And("the manifest holds no raw {string}", (_ctx, raw: string) => {
        expect(manifest).not.toContain(raw);
      });
    });
  });

  Rule("When a learner has visited every page of a packaged course, tutors shall report the course to the LMS as completed with full progress.", ({ RuleScenario }) => {
    RuleScenario("Completion is reported once the whole course has been seen", ({ Given, When, Then, And }) => {
      Given("a packaged course of {number} pages in a SCORM {string} LMS", packaged);
      When("the learner visits every page", visitsEvery);
      Then("the LMS holds {string} as {string}", lmsHolds);
      And("the LMS holds {string} as {string}", lmsAlsoHolds);
    });

    RuleScenario("A SCORM 1.2 LMS hears the same", ({ Given, When, Then }) => {
      Given("a packaged course of {number} pages in a SCORM {string} LMS", packaged);
      When("the learner visits every page", visitsEvery);
      Then("the LMS holds {string} as {string}", lmsHolds);
    });
  });

  Rule("When a learner leaves a packaged course, tutors shall report the session time in the format the LMS profile requires.", ({ RuleScenario }) => {
    const leavesAfter = (_ctx: unknown, seconds: number) => {
      harness.tick(seconds);
      harness.pagehide();
    };

    RuleScenario("Session time in the SCORM 1.2 format", ({ Given, When, Then }) => {
      Given("a packaged course of {number} pages in a SCORM {string} LMS", packaged);
      When("the learner leaves after {number} seconds", leavesAfter);
      Then("the LMS holds {string} as {string}", lmsHolds);
    });

    RuleScenario("Session time in the SCORM 2004 format", ({ Given, When, Then }) => {
      Given("a packaged course of {number} pages in a SCORM {string} LMS", packaged);
      When("the learner leaves after {number} seconds", leavesAfter);
      Then("the LMS holds {string} as {string}", lmsHolds);
    });
  });

  Rule("While a learner has visited only part of a packaged course, tutors shall report the attempt as incomplete and suspend it with the visited pages kept when the learner leaves.", ({ RuleScenario }) => {
    RuleScenario("Partial progress is reported as incomplete", ({ Given, When, Then, And }) => {
      Given("a packaged course of {number} pages in a SCORM {string} LMS", packaged);
      When("the learner visits pages {number} to {number} and leaves", visitsSomeAndLeaves);
      Then("the LMS holds {string} as {string}", lmsHolds);
      And("the LMS holds {string} as {string}", lmsAlsoHolds);
      And("the attempt is terminated", () => expect(harness.lms.terminated).toBe(true));
      And("a resumed attempt finishes after visiting pages {number} to {number}", (_ctx, from: number, to: number) => {
        const resumed = launchScormRuntime({ version, totalPages, initialCmi: harness.lms.cmi });
        expect(resumed.lms.cmi["cmi.core.lesson_status"]).toBe("incomplete");
        // The remaining pages are enough to finish, which is only true if the first ones came back with the learner.
        for (let page = from; page <= to; page += 1) resumed.visit(page, `page-${page}.html`);
        expect(resumed.lms.cmi["cmi.core.lesson_status"]).toBe("completed");
      });
    });

    RuleScenario("A 2004 LMS hears the progress measure", ({ Given, When, Then, And }) => {
      Given("a packaged course of {number} pages in a SCORM {string} LMS", packaged);
      When("the learner visits pages {number} to {number} and leaves", visitsSomeAndLeaves);
      Then("the LMS holds {string} as {string}", lmsHolds);
      And("the LMS holds {string} as {string}", lmsAlsoHolds);
    });

    RuleScenario("A finished course ends the attempt", ({ Given, When, Then, And }) => {
      Given("a packaged course of {number} pages in a SCORM {string} LMS", packaged);
      When("the learner visits every page and leaves", () => {
        visitsEvery();
        harness.pagehide();
      });
      Then("the LMS holds {string} as {string}", lmsHolds);
      And("the LMS holds {string} as {string}", lmsAlsoHolds);
    });
  });

  Rule("While a learner has a suspended attempt with a saved location, tutors shall reopen the packaged course at the page the learner left.", ({ RuleScenario }) => {
    const returns = () => {
      harness = launchScormRuntime({ version, totalPages, initialCmi: harness.lms.cmi });
      harness.domContentLoaded();
    };

    RuleScenario("A resumed attempt reopens where the learner left off", ({ Given, And, When, Then }) => {
      Given("a packaged course of {number} pages in a SCORM {string} LMS", packaged);
      And("the learner left at page {number}, {string}", (_ctx, page: number, file: string) => {
        harness.visit(page, file);
        harness.pagehide();
      });
      When("the learner returns to the package", returns);
      Then("the package opens {string}", (_ctx, file: string) => expect(harness.frameSrc()).toBe(file));
    });

    RuleScenario("A first attempt opens the entry page", ({ Given, When, Then }) => {
      Given("a packaged course of {number} pages in a SCORM {string} LMS", packaged);
      When("the learner returns to the package", returns);
      Then("the package leaves the entry page as written", () => expect(harness.frameSrc()).toBe(""));
    });
  });

  Rule("Where a course declares a scorm version in its properties, tutors shall export only that profile with the declared identifier.", ({ RuleScenario }) => {
    RuleScenario("The exported profile is configurable", ({ Given, When, Then, And }) => {
      Given("the course's properties declare scorm version {string} and identifier {string}", (_ctx, scormVersion: string, identifier: string) => {
        declared = courseWithProperties({ scorm: { version: scormVersion, identifier } });
      });
      When("the course's export profiles are read", readsProfiles);
      Then("the course exports the profiles {string}", exportsProfiles);
      And("the manifest carries the identifier {string}", (_ctx, identifier: string) => {
        expect(buildManifest(declared, [], { version: "1.2", identifier: declared.scormIdentifier })).toContain(`identifier="${identifier}"`);
      });
    });

    RuleScenario("A numeric version is read as the 2004 profile", ({ Given, When, Then }) => {
      Given("the course's properties declare scorm version {number}", (_ctx, scormVersion: number) => {
        declared = courseWithProperties({ scorm: { version: scormVersion } });
      });
      When("the course's export profiles are read", readsProfiles);
      Then("the course exports the profiles {string}", exportsProfiles);
    });

    RuleScenario("Both profiles are exported when no version is declared", ({ Given, When, Then }) => {
      Given("the course's properties declare no scorm version", () => {
        declared = courseWithProperties({ scorm: { identifier: "MY-COURSE" } });
      });
      When("the course's export profiles are read", readsProfiles);
      Then("the course exports the profiles {string}", exportsProfiles);
    });
  });

  Rule("If a learner's saved progress is unreadable or was recorded against a different page count, then tutors shall treat the progress as unset.", ({ RuleScenario }) => {
    RuleScenario("Republishing must not misreport existing learners", ({ Given, And, When, Then }) => {
      Given("a packaged course of {number} pages in a SCORM {string} LMS", packaged);
      And("the learner visited pages {number} to {number} and left", visitsSomeAndLeaves);
      When("the course is republished with {number} pages and the learner returns", (_ctx, pages: number) => {
        // Every bit of the saved progress now means a different page.
        totalPages = pages;
        harness = launchScormRuntime({ version, totalPages, initialCmi: harness.lms.cmi });
      });
      Then("the LMS holds {string} as {string}", lmsHolds);
      And("the LMS holds {string} as {string}", lmsAlsoHolds);
      And("the saved progress is re-encoded for {number} pages", (_ctx, pages: number) => {
        expect(harness.lms.cmi["cmi.suspend_data"]).toContain(`v1:${pages}:`);
      });
    });

    RuleScenario("Unreadable saved progress is unset", ({ Given, Then }) => {
      Given("a packaged course of {number} pages in a SCORM {string} LMS whose saved progress reads {string}", (_ctx, pages: number, lms: string, data: string) => {
        version = lms as "1.2" | "2004";
        totalPages = pages;
        harness = launchScormRuntime({ version, totalPages, initialCmi: { "cmi.suspend_data": data } });
      });
      Then("the LMS holds {string} as {string}", lmsHolds);
    });
  });
});
