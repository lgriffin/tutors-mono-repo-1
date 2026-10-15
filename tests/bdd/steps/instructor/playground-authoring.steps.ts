import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { afterAll, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseCourse } from "../../../../packages/jsr/gen/src/tutors";
import { mergeWorkspace } from "../../../../packages/domain/src/course/playground.ts";
import { supabasePlaygroundSnapshots } from "../../../../packages/adapters/driven/store-supabase/src/playground-snapshots.ts";
import type { PlaygroundSnapshot, PlaygroundSnapshots } from "../../../../packages/application/src/ports/index.ts";
import { MockSupabaseClient } from "../../support/mocks";
import type { Lo, Playground, Topic } from "../../../../packages/domain/src/course/types/learning-objects";

/**
 * The instructor's two sides of a playground: writing one, and reading what came back.
 *
 * Authoring is checked by building a real course folder, because that is the interface an
 * instructor actually has. Review is checked against the token the reader signs and the
 * policies on the table, because those — not the page — decide who sees whose work.
 */

vi.mock("@tutors/logger", () => ({ default: { error: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

const feature = await loadFeature("tests/bdd/features/instructor/playground-authoring.feature");

const MIGRATION = path.join(process.cwd(), "supabase/migrations/20261018000200_create_playground_snapshots.sql");

function write(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

/** A token shaped like the one /api/runtime-token signs for a signed-in reader. */
function token(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(claims)}.signature`;
}

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
  course_id: "course.test",
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
  let client: MockSupabaseClient;
  let snapshots: PlaygroundSnapshots;
  let available: boolean;
  let reviews: boolean;
  let submissions: PlaygroundSnapshot[];

  /** The snapshot store against a reader that answers the token request like this. */
  const storeFor = (response: { ok: boolean; body?: unknown }) => {
    client = new MockSupabaseClient();
    client.setTableData("playground_snapshots", []);
    snapshots = supabasePlaygroundSnapshots({
      url: "https://mock.supabase.co",
      key: "mock-anon-key",
      fetchFn: (async () => ({ ok: response.ok, json: async () => response.body })) as unknown as typeof fetch,
      clientFor: () => client as never
    });
  };

  const playground = (name: string) => {
    const lo = built.get(name);
    if (!lo) throw new Error(`no playground ${name} was built`);
    return lo;
  };
  const paths = (name: string) => playground(name).files.map((file) => file.path);

  Background(({ Given }) => {
    Given("an instructor has authored a course with playground folders", () => {
      if (!scratch) scratch = authorCourse();
      storeFor({ ok: true, body: { token: token({ sub: "ada" }), expiresIn: 3600 } });
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
    available = await snapshots.available("course.test");
    reviews = await snapshots.reviews("course.test");
    submissions = await snapshots.list("course.test", "lo");
  };
  const studentToken = () => storeFor({ ok: true, body: { token: token({ sub: "ada" }), expiresIn: 3600 } });
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
      Given("the reader signs a token naming the instructor an educator of the course", () => {
        storeFor({ ok: true, body: { token: token({ sub: "grace", educator_courses: ["course.test"] }), expiresIn: 3600 } });
      });
      And("{string} handed in {string} that printed {string} and failed", (_ctx, name: string, _file: string, output: string) => {
        client.setTableData("playground_snapshots", [snapshotRow(name, output, false)]);
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
      Given("the reader signs a token for a student of the course", studentToken);
      When("the instructor opens the exercise's submissions", opensSubmissions);
      Then("the reader does not treat the student as a reviewer", notReviewer);
    });
  });

  Rule("If a page claims a student teaches a course, then the reader shall grant review from the claim the reader signed and from nothing else.", ({ RuleScenario }) => {
    const policies = fs.readFileSync(MIGRATION, "utf8");

    RuleScenario("A student cannot make themselves an instructor", ({ Given, When, Then, And }) => {
      Given("the reader signs a token for a student of the course", studentToken);
      When("the instructor opens the exercise's submissions", opensSubmissions);
      Then("the reader does not treat the student as a reviewer", notReviewer);
      And("the submissions table is closed to the anonymous role", () => {
        expect(policies).toContain("ENABLE ROW LEVEL SECURITY");
        expect(policies).not.toMatch(/TO\s+anon/i);
      });
      And("every policy on the submissions table reads the signed claims", () => {
        const policyCount = policies.match(/CREATE POLICY/g)?.length ?? 0;
        const claimChecks = policies.match(/auth\.jwt\(\)/g)?.length ?? 0;
        expect(policyCount).toBeGreaterThan(0);
        expect(claimChecks).toBeGreaterThanOrEqual(policyCount);
      });
      And("the educator policy lets an instructor read submissions and write none", () => {
        const educatorPolicy = policies.slice(policies.indexOf('CREATE POLICY "educator_snapshot_select"'));
        expect(educatorPolicy).toContain("FOR SELECT");
        expect(educatorPolicy).toContain("educator_courses");
        expect(educatorPolicy).not.toContain("WITH CHECK");
      });
    });
  });

  Rule("If the reader cannot mint a run-time token, then the reader shall offer no handing in while the exercise itself still runs.", ({ RuleScenario }) => {
    RuleScenario("A deployment with no Supabase secret", ({ Given, When, Then, And }) => {
      Given("the reader has no secret to sign a run-time token with", () => storeFor({ ok: false }));
      When("the instructor opens the exercise's submissions", opensSubmissions);
      Then("handing in is not available", () => expect(available).toBe(false));
      And("the submissions are empty", () => expect(submissions).toEqual([]));
      And("the exercise's workspace still opens as authored", () => {
        // Nothing about running, saving or sharing a playground goes through Supabase.
        const lo = { type: "playground", runtime: "python", entry: "main.py", files: [{ path: "main.py", content: "print(1)" }] } as Playground;
        expect(mergeWorkspace(lo, null)).toEqual([{ path: "main.py", content: "print(1)" }]);
      });
    });
  });
});
