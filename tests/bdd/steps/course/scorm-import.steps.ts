import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { afterAll, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildTree, copyAssetFiles } from "../../../../packages/jsr/gen/src/services/resource-builder";
import { buildCourse } from "../../../../packages/jsr/gen/src/services/course-builder";
import { extractScormPackage, SCORM_CONTENT_FOLDER } from "../../../../packages/jsr/gen/src/scorm/package";
import { preOrder, simpleTypes } from "../../../../packages/domain/src/course/types/type-utils";
import { icons, loColours } from "../../../../packages/jsr/gen/src/templates/styles";
import { FluentIconLib } from "../../../../packages/adapters/driving/themes/src/icons/fluent-icons";
import { HeroIconLib } from "../../../../packages/adapters/driving/themes/src/icons/hero-icons";
import { FestiveIcons } from "../../../../packages/adapters/driving/themes/src/icons/festive-icons";
import { EasterIcons } from "../../../../packages/adapters/driving/themes/src/icons/easter-icons";
import { createLocalScormStore, installScormApi, resolveScormAsset, scormAssetUrl, type Scorm12Api, type ScormStore } from "../../../../packages/adapters/driving/scorm-runtime/src/index";
import { buildZip } from "../../../support/zip-writer";
import type { Course, Lo, Scorm } from "../../../../packages/domain/src/course/types/learning-objects";

const feature = await loadFeature("tests/bdd/features/course/scorm-import.feature");

function manifestXml(options: { schemaVersion: string; title: string; href: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="VENDOR-PACKAGE" version="1.0">
  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>${options.schemaVersion}</schemaversion>
  </metadata>
  <organizations default="ORG-1">
    <organization identifier="ORG-1">
      <title>${options.title}</title>
      <item identifier="ITEM-1" identifierref="RES-1">
        <title>${options.title}</title>
      </item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="RES-1" type="webcontent" adlcp:scormtype="sco" href="${options.href}">
      <file href="${options.href}" />
    </resource>
  </resources>
</manifest>
`;
}

function write(file: string, contents: string | Uint8Array): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

/** Depth-first search of a built course tree. */
function findById(los: Lo[], id: string): Lo | undefined {
  for (const lo of los) {
    if (lo.id === id) return lo;
    const found = findById(lo.los ?? [], id);
    if (found) return found;
  }
  return undefined;
}

function authorCourse(): string {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "tutors-scorm-src-"));
  write(path.join(source, "course.md"), "# Smoke Course\n\nA course with imported SCORM content.\n");
  write(path.join(source, "topic-01", "topic.md"), "# Topic One\n\nHolds the imported packages.\n");

  // Already unpacked, the way an author who unzipped it themselves would leave it,
  // with Tutors' own markdown and card image sitting alongside the vendor's files.
  const unpacked = path.join(source, "topic-01", "scorm-quiz");
  write(path.join(unpacked, "imsmanifest.xml"), manifestXml({ schemaVersion: "1.2", title: "Vendor Quiz", href: "shared/launch.html" }));
  write(path.join(unpacked, "shared", "launch.html"), "<html><body>quiz</body></html>");
  write(path.join(unpacked, "shared", "quiz.js"), "/* vendor */");
  write(path.join(unpacked, "player.js"), "/* vendor, at the package root */");
  write(path.join(unpacked, "scorm-quiz.md"), "---\nmasteryScore: 60\n---\n\n# Try the Quiz\n\nA vendor package, imported.\n");
  write(path.join(unpacked, "scorm-quiz.png"), "not really a png");

  // Exactly as downloaded: one zip, nothing else but the card image.
  const packed = path.join(source, "topic-01", "scorm-packed");
  write(
    path.join(packed, "vendor.zip"),
    buildZip([
      { name: "imsmanifest.xml", contents: manifestXml({ schemaVersion: "2004 4th Edition", title: "Vendor Module", href: "start.html" }), deflate: true },
      { name: "start.html", contents: "<html><body>module</body></html>", deflate: true },
      { name: "assets/" },
      { name: "assets/module.css", contents: "body { color: red; }" }
    ])
  );
  write(path.join(packed, "scorm-packed.png"), "not really a png");

  // Neither a manifest nor a zip: an author who has not finished setting it up.
  write(path.join(source, "topic-01", "scorm-empty", "notes.txt"), "package still to come");
  return source;
}

// Authored once for the whole feature and removed when the file's suites are done.
let source = "";
let output = "";
const scratch: string[] = [];
afterAll(() => {
  [source, output, ...scratch].filter(Boolean).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});

describeFeature(feature, ({ Background, Rule }) => {
  let course: Course;
  let api: Scorm12Api;
  let uninstall: () => void;
  let saved: Record<string, string>;
  let store: ScormStore;
  let hostile = "";
  let destination = "";

  Background(({ Given }) => {
    Given("a course folder holding an unpacked SCORM 1.2 package, a vendor zip and an empty scorm folder", () => {
      if (!source) source = authorCourse();
      if (!output) output = fs.mkdtempSync(path.join(os.tmpdir(), "tutors-scorm-out-"));
    });
  });

  const scormLo = (id: string) => findById(course.los, id) as Scorm;
  const packageFolder = (id: string) => path.join(output, "topic-01", id, SCORM_CONTENT_FOLDER);
  const loFolder = (id: string) => path.join(output, "topic-01", id);
  const buildsCourse = () => {
    course = buildCourse(buildTree(source), true);
  };
  const copiesAssets = () => {
    copyAssetFiles(buildTree(source), output);
  };
  const declaresVersion = (_ctx: unknown, id: string, version: string) => expect(scormLo(id).scormVersion).toBe(version);
  const launches = (_ctx: unknown, id: string, file: string) => {
    expect(scormLo(id).scormFile).toBe(file);
    expect(scormLo(id).scorm).toBe(`https://{{COURSEURL}}/topic-01/${id}/${SCORM_CONTENT_FOLDER}/${file}`);
  };
  const initialises = () => {
    const target = {} as Window;
    ({ uninstall } = installScormApi(target, {
      version: "1.2",
      learnerId: "learner-1",
      learnerName: "A Learner",
      store: { load: () => ({ ...saved }), save: () => {} }
    }));
    api = (target as unknown as { API: Scorm12Api }).API;
    api.LMSInitialize("");
  };
  const reads = (_ctx: unknown, element: string, value: string) => expect(api.LMSGetValue(element)).toBe(value);
  const readsBookmark = (_ctx: unknown, element: string, value: string, other: string, otherValue: string) => {
    expect(api.LMSGetValue(element)).toBe(value);
    expect(api.LMSGetValue(other)).toBe(otherValue);
  };

  Rule("tutors shall recognise scorm as a simple learning object type with an icon and a colour in every theme.", ({ RuleScenario }) => {
    RuleScenario("A scorm folder is a first-class learning object type", ({ Then, And }) => {
      Then("scorm is a simple learning object type with a place in the ordering", () => {
        expect(simpleTypes).toContain("scorm");
        expect(preOrder.get("scorm")).toBeDefined();
      });
      And("every icon library gives scorm an icon and a colour", () => {
        [FluentIconLib, HeroIconLib, FestiveIcons, EasterIcons].forEach((library) => {
          expect(library.scorm?.type).toBeTruthy();
          expect(library.scorm?.color).toBeTruthy();
        });
      });
      And("the generator's templates give scorm an icon and a colour", () => {
        expect(icons.scorm).toBeTruthy();
        expect(loColours.scorm).toBeTruthy();
      });
    });
  });

  Rule("When a course is built from a folder holding an unpacked SCORM package, tutors shall read the version, launch file, title and mastery score into the learning object.", ({ RuleScenario }) => {
    RuleScenario("An unpacked package becomes a learning object", ({ When, Then, And }) => {
      When("the course is built", buildsCourse);
      Then("the {string} learning object declares SCORM version {string}", declaresVersion);
      And("the {string} learning object launches {string} from inside its package folder", launches);
      And("the {string} learning object is titled {string} by its author rather than its package", (_ctx, id: string, title: string) => {
        expect(scormLo(id).title).toBe(title);
      });
      And("the {string} learning object has a mastery score of {number}", (_ctx, id: string, score: number) => {
        expect(scormLo(id).masteryScore).toBe(score);
      });
    });
  });

  Rule("When a course is built from a folder holding only the vendor's zip, tutors shall read the manifest from inside the zip and unpack the package into the generated course.", ({ RuleScenario }) => {
    RuleScenario("A vendor zip is accepted exactly as downloaded", ({ When, And, Then }) => {
      When("the course is built", buildsCourse);
      And("the course's assets are copied to the output folder", copiesAssets);
      Then("the {string} learning object declares SCORM version {string}", declaresVersion);
      And("the {string} learning object launches {string} from inside its package folder", launches);
      And("the {string} learning object is titled {string} after its package", (_ctx, id: string, title: string) => {
        expect(scormLo(id).title).toBe(title);
      });
      And("the output holds {string} and {string} inside the {string} package folder", (_ctx, first: string, second: string, id: string) => {
        expect(fs.readFileSync(path.join(packageFolder(id), first), "utf8")).toContain("module");
        expect(fs.readFileSync(path.join(packageFolder(id), second), "utf8")).toContain("color: red");
      });
    });
  });

  Rule("tutors shall publish an imported package's files once, in a package folder beneath the learning object, beside the card image and without the author's markdown or the vendor zip.", ({ RuleScenario }) => {
    RuleScenario("Package files are published beneath the learning object", ({ When, Then, And }) => {
      When("the course's assets are copied to the output folder", copiesAssets);
      Then("the output holds {string}, {string} and {string} inside the {string} package folder", (_ctx, first: string, second: string, third: string, id: string) => {
        [first, second, third].forEach((file) => expect(fs.existsSync(path.join(packageFolder(id), file))).toBe(true));
      });
      // The static emitter writes index.html into the learning object folder itself, so
      // nothing from the package may land there.
      And("the output leaves {string} and {string} out of the {string} learning object folder", (_ctx, first: string, second: string, id: string) => {
        expect(fs.existsSync(path.join(loFolder(id), first))).toBe(false);
        expect(fs.existsSync(path.join(loFolder(id), second))).toBe(false);
      });
      And("the output holds {string} inside the {string} package folder and not in the learning object folder", (_ctx, file: string, id: string) => {
        // Everything the SCO loads is served from the package folder, so a second copy at
        // the learning object root would be dead weight the browser never asks for.
        expect(fs.existsSync(path.join(packageFolder(id), file))).toBe(true);
        expect(fs.existsSync(path.join(loFolder(id), file))).toBe(false);
      });
      And("the output leaves {string} out of the {string} package folder", (_ctx, file: string, id: string) => {
        // The markdown is Tutors' own metadata; the vendor's manifest does not list it and
        // a conformance checker would flag it as an unreferenced file.
        expect(fs.existsSync(path.join(packageFolder(id), file))).toBe(false);
      });
      And("the output holds {string} in the {string} learning object folder", (_ctx, file: string, id: string) => {
        expect(fs.existsSync(path.join(loFolder(id), file))).toBe(true);
      });
    });
  });

  Rule("The reader shall frame an imported package from its own origin and pass through only files inside a package folder on a public host.", ({ RuleScenario }) => {
    RuleScenario("The package is framed from the reader's own origin", ({ Then, And }) => {
      Then("the package address {string} is framed as {string}", (_ctx, address: string, framed: string) => {
        // A SCO finds the LMS by walking up window.parent, and that walk stops at an origin
        // boundary, so the package has to be served from the page that publishes the API.
        expect(scormAssetUrl(address)).toBe(framed);
      });
      And("the path {string} on {string} is passed through", (_ctx, file: string, host: string) => {
        expect(resolveScormAsset(host, file)).toBe(`https://${host}/${file}`);
      });
      And("the path {string} on {string} is refused", (_ctx, file: string, host: string) => {
        expect(resolveScormAsset(host, file)).toBeUndefined();
      });
      And("the private host {string} is refused for {string}", (_ctx, host: string, file: string) => {
        expect(resolveScormAsset(host, file)).toBeUndefined();
      });
    });
  });

  Rule("While a learner has a suspended attempt at an imported package, the reader shall report the attempt to the content as resumable with its saved bookmark.", ({ RuleScenario }) => {
    RuleScenario("A learner resumes where they left off", ({ Given, When, Then, And }) => {
      Given("a learner's saved attempt is suspended at {string} with suspend data {string}", (_ctx, location: string, data: string) => {
        saved = { "cmi.core.lesson_status": "incomplete", "cmi.core.lesson_location": location, "cmi.core.exit": "suspend", "cmi.suspend_data": data };
      });
      When("the content initialises the SCORM 1.2 run-time", initialises);
      Then("the content reads {string} as {string}", reads);
      And("the content reads the bookmark {string} as {string} and {string} as {string}", readsBookmark);
      And("the run-time is taken down", () => uninstall());
    });

    RuleScenario("A first attempt starts from the beginning", ({ Given, When, Then, And }) => {
      Given("a learner has no saved attempt", () => {
        saved = {};
      });
      When("the content initialises the SCORM 1.2 run-time", initialises);
      Then("the content reads {string} as {string}", reads);
      And("the content reads the bookmark {string} as {string} and {string} as {string}", readsBookmark);
      And("the run-time is taken down", () => uninstall());
    });
  });

  Rule("If the browser denies the reader storage, then the reader shall keep a SCORM attempt in memory for the session.", ({ RuleScenario }) => {
    RuleScenario("Private browsing keeps the attempt for the session", ({ Given, When, Then }) => {
      Given("the browser denies storage", () => {
        // Under Node there is no localStorage at all, which is what private browsing and
        // sandboxed frames look like to the store: every access throws.
        expect(typeof globalThis.localStorage).toBe("undefined");
        store = createLocalScormStore("smoke", "/scorm/smoke/topic-01/scorm-quiz");
      });
      When("the run-time saves a bookmark of {string}", (_ctx, location: string) => {
        store.save({ "cmi.core.lesson_location": location }, { completionStatus: "incomplete", successStatus: "unknown", totalTime: 0, location });
      });
      Then("the run-time reads the bookmark {string} back", (_ctx, location: string) => {
        expect(store.load()["cmi.core.lesson_location"]).toBe(location);
      });
    });
  });

  Rule("If a scorm folder holds no manifest and no zip, then tutors shall continue the build with that learning object left without a launch address.", ({ RuleScenario }) => {
    RuleScenario("A folder with no manifest is reported, not fatal", ({ When, Then, And }) => {
      When("the course is built", buildsCourse);
      Then("the course holds the {string} learning object", (_ctx, id: string) => {
        expect(course.los[0].los.map((lo) => lo.id)).toContain(id);
      });
      And("the {string} learning object has no launch address", (_ctx, id: string) => {
        expect(scormLo(id).type).toBe("scorm");
        expect(scormLo(id).scorm).toBeUndefined();
        expect(scormLo(id).scormFile).toBeUndefined();
      });
    });
  });

  Rule("If a zip entry names a path outside the destination folder, then tutors shall skip that entry.", ({ RuleScenario }) => {
    RuleScenario("A malicious archive cannot escape the output folder", ({ Given, When, Then, And }) => {
      Given("a zip whose entries are {string} and {string}", (_ctx, inside: string, outside: string) => {
        hostile = fs.mkdtempSync(path.join(os.tmpdir(), "tutors-scorm-zip-"));
        scratch.push(hostile);
        write(
          path.join(hostile, "hostile.zip"),
          buildZip([
            { name: "imsmanifest.xml", contents: manifestXml({ schemaVersion: "1.2", title: "Hostile", href: inside }) },
            { name: inside, contents: "<html></html>" },
            { name: outside, contents: "should never be written" }
          ])
        );
        destination = path.join(hostile, "out");
      });
      When("the zip is unpacked", () => {
        extractScormPackage(path.join(hostile, "hostile.zip"), destination);
      });
      Then("{string} is written into the destination", (_ctx, file: string) => {
        expect(fs.existsSync(path.join(destination, file))).toBe(true);
      });
      And("{string} is not written beside it", (_ctx, file: string) => {
        expect(fs.existsSync(path.join(hostile, file))).toBe(false);
      });
    });
  });
});
