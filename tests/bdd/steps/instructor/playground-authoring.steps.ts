import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { afterAll, expect, vi } from "vitest";

// The seams: the `pg` driver (the in-process store, backend.ts) and the environments.
vi.mock("pg", async () => (await import("../../support/backend.ts")).pgModule);
vi.mock("$app/env/public", async () => (await import("../../support/backend.ts")).publicEnv);
vi.mock("$app/env/private", async () => (await import("../../support/backend.ts")).privateEnv);
vi.mock("$app/env", () => ({ browser: true, building: false, dev: false }));

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseCourse } from "../../../../packages/jsr/gen/src/tutors";
import { mergeWorkspace } from "../../../../packages/domain/src/course/playground.ts";
import { readerApiPlaygroundSnapshots } from "../../../../packages/adapters/driven/data-api/src/index.ts";
import type { PlaygroundSnapshot, PlaygroundSnapshots } from "../../../../packages/application/src/ports/index.ts";
import { installReaderFetch, readerRequest, resetReaderApi, serveCourseJson, setReaderSession } from "../../support/reader-api.ts";
import { backend, privateEnv } from "../../support/backend.ts";
import type { Lo, Playground, Topic } from "../../../../packages/domain/src/course/types/learning-objects";

/**
 * The instructor's two sides of a playground: writing one, and reading what came back.
 *
 * Authoring is checked by building a real course folder, because that is the interface an
 * instructor actually has. Review is checked through the reader's real /api/playground route,
 * with the session and the course's published educators, because those (not the page) decide
 * who sees whose work.
 */

vi.mock("@tutors/logger", async (importOriginal) => ({ ...(await importOriginal<object>()), default: { error: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

const feature = await loadFeature("tests/bdd/features/instructor/playground-authoring.feature");

function write(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

/** The course the review scenarios hand work in to; Grace teaches it. */
const COURSE = "playground-course";
const DATABASE_URL = privateEnv.PRIVATE_DATABASE_URL;

const person = (name: string) => {
  const login = name.toLowerCase();
  return { name, login, email: `${login}@example.com`, image: "", share: "true", sentiment: "neutral" };
};

function authorCourse(): string {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tutors-playground-bdd-"));
  write(path.join(scratch, "course.md"), "# Programming\n\nExercises.\n");
  const topic = path.join(scratch, "topic-01-exercises");
  write(path.join(topic, "topic.md"), "# Exercises\n");

  write(path.join(topic, "playground-01-simple", "main.py"), "print('hello')\n");

  const mixed = path.join(topic, "playground-02-mixed");
  write(path.join(mixed, "helper.py"), "def double(n):\n    return n * 2\n");
  write(path.join(mixed, "main.py"), "print(double(21))\n");
  write(path.join(mixed, "data.json"), '{ "answer": 42 }\n');
  write(path.join(mixed, "test_main.py"), "assert double(2) == 4\n");
  write(path.join(mixed, "notes.md"), "Read this first.\n");

  const configured = path.join(topic, "playground-03-configured");
  write(path.join(configured, "exercise.ts"), "export const answer = 42;\n");
  write(path.join(configured, "scaffold.ts"), "export const given = 1;\n");
  write(path.join(configured, "checks.ts"), "console.log(answer);\n");
  write(
    path.join(configured, "playground.yaml"),
    ["runtime: typescript", "entry: exercise.ts", "tests: checks.ts", "packages:", "  - lodash", "readOnly:", "  - scaffold.ts", ""].join("\n")
  );

  const oversized = path.join(topic, "playground-04-oversized");
  write(path.join(oversized, "main.js"), "console.log(1);\n");
  write(path.join(oversized, "huge.js"), `// ${"x".repeat(300 * 1024)}\n`);
  return scratch;
}

const snapshotRow = (name: string, output: string, ok: boolean) => ({
  student_id: name.split(" ")[0].toLowerCase(),
  student_name: name,
  course_id: COURSE,
  lo_id: "lo",
  runtime: "python",
  entry: "main.py",
  files: [{ path: "main.py", content: "print(1)" }],
  last_output: `${output}\n`,
  last_ok: ok,
  updated_at: "2026-09-10T09:00:00.000Z"
});

// Authored once for the whole feature and removed when the file's suites are done.
let scratch = "";
afterAll(() => {
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
});

describeFeature(feature, ({ Background, Rule }) => {
  let built: Map<string, Playground>;
  let snapshots: PlaygroundSnapshots;
  let available: boolean;
  let reviews: boolean;
  let submissions: PlaygroundSnapshot[];

  /** The browser's snapshot store over the reader's data API, with `name` signed in to the reader. */
  const signedIn = async (name: string) => {
    await backend.reset();
    resetReaderApi();
    installReaderFetch();
    privateEnv.PRIVATE_DATABASE_URL = DATABASE_URL;
    serveCourseJson(COURSE, { title: "Programming", enrollment: { educators: ["grace"] } });
    setReaderSession(person(name));
    snapshots = readerApiPlaygroundSnapshots();
  };

  const playground = (name: string) => {
    const lo = built.get(name);
    if (!lo) throw new Error(`no playground ${name} was built`);
    return lo;
  };
  const paths = (name: string) => playground(name).files.map((file) => file.path);

  Background(({ Given }) => {
    Given("an instructor has authored a course with playground folders", async () => {
      if (!scratch) scratch = authorCourse();
      await signedIn("Ada");
    });
  });

  const buildsCourse = () => {
    const [course] = parseCourse(scratch, true);
    const topic = course.los.find((lo: Lo) => lo.type === "topic") as Topic;
    built = new Map();
    for (const lo of topic.los) {
      if (lo.type !== "playground") continue;
      const name = lo.route.split("-").pop() ?? "";
      built.set(name, lo as Playground);
    }
  };
  const entryIs = (_ctx: unknown, name: string, entry: string) => expect(playground(name).entry).toBe(entry);
  const runtimeIs = (_ctx: unknown, name: string, runtime: string) => expect(playground(name).runtime).toBe(runtime);
  const leavesOut = (_ctx: unknown, name: string, file: string) => expect(paths(name)).not.toContain(file);
  const testsAre = (_ctx: unknown, name: string, file: string, content: string) => {
    expect(playground(name).tests?.path).toBe(file);
    expect(playground(name).tests?.content).toContain(content);
  };
  const opensSubmissions = async () => {
    available = await snapshots.available(COURSE);
    reviews = await snapshots.reviews(COURSE);
    submissions = await snapshots.list(COURSE, "lo");
  };
  const studentSignedIn = () => signedIn("Ben");
  const notReviewer = () => expect(reviews).toBe(false);

  Rule("When a course is built from a playground folder holding one source file, tutors shall make that file the entry point with the run-time chosen from its extension.", ({ RuleScenario }) => {
    RuleScenario("A folder of code becomes an exercise", ({ When, Then, And }) => {
      When("the course is built", buildsCourse);
      Then("the {string} playground's entry point is {string}", entryIs);
      And("the {string} playground's run-time is {string}", runtimeIs);
      And("the {string} playground, whose entry point is JavaScript, runs on {string}", runtimeIs);
      And("the {string} playground's workspace is that one file", (_ctx, name: string) => {
        expect(playground(name).files).toHaveLength(1);
        expect(playground(name).files[0].content).toContain("print('hello')");
      });
    });
  });

  Rule("tutors shall carry a playground folder's source and data files into the workspace, entry point first, and leave the prose out of it.", ({ RuleScenario }) => {
    RuleScenario("The workspace holds what the exercise needs and nothing else", ({ When, Then, And }) => {
      When("the course is built", buildsCourse);
      Then("the {string} playground's workspace holds {string} and {string}", (_ctx, name: string, first: string, second: string) => {
        expect(paths(name)).toContain(first);
        expect(paths(name)).toContain(second);
      });
      And("the {string} playground's workspace leaves out {string}", leavesOut);
      And("the {string} playground's workspace lists {string} first", (_ctx, name: string, file: string) => {
        expect(paths(name)[0]).toBe(file);
      });
    });
  });

  Rule("When a playground folder holds a test file, tutors shall carry the tests separately from the student's workspace.", ({ RuleScenario }) => {
    RuleScenario("Checks the student can run but not edit", ({ When, Then, And }) => {
      When("the course is built", buildsCourse);
      Then("the {string} playground's workspace leaves out {string}", leavesOut);
      And("the {string} playground's tests are {string} reading {string}", testsAre);
    });
  });

  Rule("Where a playground folder declares a playground.yaml, tutors shall take the run-time, entry point, packages, tests and read-only files from it.", ({ RuleScenario }) => {
    RuleScenario("The defaults can be overridden", ({ When, Then, And }) => {
      When("the course is built", buildsCourse);
      Then("the {string} playground's run-time is {string}", runtimeIs);
      And("the {string} playground's entry point is {string}", entryIs);
      And("the {string} playground's packages are {string}", (_ctx, name: string, packages: string) => {
        expect(playground(name).packages).toEqual(packages.split(",").map((item) => item.trim()));
      });
      And("the {string} playground's tests are {string} reading {string}", testsAre);
      And("the {string} playground's workspace leaves out {string}", leavesOut);
      And("the {string} playground's {string} is read-only", (_ctx, name: string, file: string) => {
        expect(playground(name).files.find((candidate) => candidate.path === file)?.readOnly).toBe(true);
      });
      And("the {string} playground's {string} is editable", (_ctx, name: string, file: string) => {
        expect(playground(name).files.find((candidate) => candidate.path === file)?.readOnly).toBeUndefined();
      });
    });

    RuleScenario("A folder with no playground.yaml takes the defaults", ({ When, Then, And }) => {
      When("the course is built", buildsCourse);
      Then("the {string} playground's run-time is {string}", runtimeIs);
      And("the {string} playground's entry point is {string}", entryIs);
      And("the {string} playground has no packages and no tests", (_ctx, name: string) => {
        expect(playground(name).packages ?? []).toEqual([]);
        expect(playground(name).tests).toBeUndefined();
      });
    });
  });

  Rule("If a file in a playground folder is too large to inline, then tutors shall build the workspace without it.", ({ RuleScenario }) => {
    RuleScenario("An exercise that would be a large download", ({ When, Then, And }) => {
      When("the course is built", buildsCourse);
      Then("the {string} playground's workspace leaves out {string}", leavesOut);
      And("the {string} playground's workspace is {string} only", (_ctx, name: string, file: string) => {
        expect(paths(name)).toEqual([file]);
      });
    });
  });

  Rule("While an instructor teaches a course, the reader shall list the submissions handed in for an exercise with the output each student last saw.", ({ RuleScenario }) => {
    RuleScenario("Reviewing what students handed in", ({ Given, And, When, Then }) => {
      Given("an educator of the course is signed in to the reader", () => signedIn("Grace"));
      And("{string} handed in {string} that printed {string} and failed", async (_ctx, name: string, _file: string, output: string) => {
        await backend.seed("playground_snapshots", [snapshotRow(name, output, false)]);
      });
      When("the instructor opens the exercise's submissions", opensSubmissions);
      Then("the instructor reviews the course", () => expect(reviews).toBe(true));
      And("the submissions list {string}", (_ctx, name: string) => {
        expect(submissions.map((snapshot) => snapshot.studentName)).toEqual([name]);
      });
      And("the submission shows {string} with the output {string} and a failed verdict", (_ctx, file: string, output: string) => {
        const [submission] = submissions;
        expect(submission.files).toEqual([{ path: file, content: "print(1)" }]);
        expect(submission.lastOutput).toContain(output);
        expect(submission.lastOk).toBe(false);
      });
    });

    RuleScenario("A student sees no review panel", ({ Given, When, Then }) => {
      Given("a student of the course is signed in to the reader", studentSignedIn);
      When("the instructor opens the exercise's submissions", opensSubmissions);
      Then("the reader does not treat the student as a reviewer", notReviewer);
    });
  });

  Rule("If a page claims a student teaches a course, then the reader shall grant review from the course's published educators, read by its server, and from nothing else.", ({ RuleScenario }) => {
    RuleScenario("A student cannot make themselves an instructor", ({ Given, When, Then, And }) => {
      Given("a student of the course is signed in to the reader", studentSignedIn);
      When("the instructor opens the exercise's submissions", opensSubmissions);
      Then("the reader does not treat the student as a reviewer", notReviewer);
      And("the reader answers 403 when the student asks for {string}'s submission", async (_ctx, name: string) => {
        await backend.seed("playground_snapshots", [snapshotRow(name, "1", true)]);
        const response = await readerRequest("GET", `/api/playground?courseId=${COURSE}&loId=lo&studentId=${name.split(" ")[0].toLowerCase()}`);
        expect(response.status).toBe(403);
      });
    });
  });

  Rule("If the reader's server has no database to keep hand-ins in, then the reader shall offer no handing in while the exercise itself still runs.", ({ RuleScenario }) => {
    RuleScenario("A deployment with no database", ({ Given, When, Then, And }) => {
      Given("the reader's server has no database URL", async () => {
        await signedIn("Ada");
        privateEnv.PRIVATE_DATABASE_URL = "";
      });
      When("the instructor opens the exercise's submissions", opensSubmissions);
      Then("handing in is not available", () => expect(available).toBe(false));
      And("the submissions are empty", () => expect(submissions).toEqual([]));
      And("the exercise's workspace still opens as authored", () => {
        // Nothing about running, saving or sharing a playground goes through the database.
        const lo = { type: "playground", runtime: "python", entry: "main.py", files: [{ path: "main.py", content: "print(1)" }] } as Playground;
        expect(mergeWorkspace(lo, null)).toEqual([{ path: "main.py", content: "print(1)" }]);
      });
    });
  });
});
