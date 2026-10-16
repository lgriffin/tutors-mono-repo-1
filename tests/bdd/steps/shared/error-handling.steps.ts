import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect, vi } from "vitest";
import { postgresCatalogue, recordCourseVisit, type SqlClient } from "@tutors/store-postgres";
import { courseService } from "../../../../packages/adapters/driving/svelte-state/src/course/services/course.svelte.ts";
import { pgliteDatabase } from "../../../support/postgres-store.ts";
import { captureLogs, courseHost, publishedCourseJson, type CourseHost, type LogCapture } from "../../support/reader-loading.ts";
import { anonymousReader } from "../../../support/reader-adapters.ts";

// `rune()` needs the Svelte compiler; see the stub for why a plain box is a faithful stand-in.
vi.mock("../../../../packages/adapters/driving/svelte-state/src/index.svelte.ts", () => import("../../support/runes-stub.ts"));
// The database is the network: PGlite (with db/migrations applied) stands in for the Postgres the
// reader's server hands the catalogue store, and the catalogue service under test is the real one.
anonymousReader();
const database = await pgliteDatabase();
/** Tables whose every query fails, as a database that lost them would. */
const failing = new Map<string, string>();
const sql: SqlClient = {
  async query(text, params) {
    for (const [table, message] of failing) if (text.includes(`"${table}"`)) throw new Error(message);
    return database.sql.query(text, params);
  },
  end: async () => {}
};
const catalogueService = postgresCatalogue(sql);

const feature = await loadFeature("tests/bdd/features/shared/error-handling.feature");

const MALFORMED_BODIES: Record<string, string> = {
  "JSON cut off mid-document": '{"title": "Cut off", "los": [',
  "a course with no learning objects": '{"title": "No los", "type": "course"}',
  "a null document": "null"
};

describeFeature(feature, ({ BeforeEachScenario, AfterEachScenario, Scenario, ScenarioOutline }) => {
  let host: CourseHost;
  let logs: LogCapture;
  let failure: unknown;

  const load = async (_ctx: unknown, courseId: string) => {
    failure = undefined;
    try {
      await courseService.readCourse(courseId, host.fetch);
    } catch (error) {
      failure = error;
    }
  };
  const logged = (_ctx: unknown, message: string) => {
    expect(logs.errors().map((entry) => entry.message)).toContain(message);
  };
  const notCached = (_ctx: unknown, courseId: string) => {
    expect(courseService.courses.has(courseId)).toBe(false);
  };

  BeforeEachScenario(() => {
    courseService.courses.clear();
    host = courseHost();
    logs = captureLogs();
  });

  AfterEachScenario(() => {
    logs.stop();
  });

  Scenario("Invalid course URL", ({ Given, When, Then, And }) => {
    Given("the course host answers 404 for {string}", (_ctx, courseId: string) => {
      host.answer(courseId, new Response("Not Found", { status: 404 }));
    });
    When("the reader loads the course {string}", load);
    Then("the load shall fail with the message {string}", (_ctx, message: string) => {
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe(message);
    });
    And("the reader shall have requested {string}", (_ctx, url: string) => {
      expect(host.requested).toEqual([url]);
    });
    And("the reader shall log the error {string}", logged);
    And("the reader shall not cache a course for {string}", notCached);
  });

  Scenario("Network failure during course load", ({ Given, When, Then, And }) => {
    Given("the network is unavailable", () => {
      host.goOffline();
    });
    When("the reader loads the course {string}", load);
    Then("the load shall fail with the message {string}", (_ctx, message: string) => {
      expect(failure).toBeInstanceOf(TypeError);
      expect((failure as Error).message).toBe(message);
    });
    And("the reader shall log the error {string}", logged);
    And("the reader shall not cache a course for {string}", notCached);
    When("the network is restored and the reader loads the course {string} again", async (_ctx, courseId: string) => {
      host.goOnline();
      host.answer(courseId, new Response(publishedCourseJson("Web Development 101")));
      await load(undefined, courseId);
    });
    Then("the course title shall be {string}", (_ctx, title: string) => {
      expect(failure).toBeUndefined();
      expect(courseService.courses.get("web-dev-101")?.title).toBe(title);
    });
  });

  ScenarioOutline("Malformed course JSON", ({ Given, When, Then, And }, variables) => {
    Given("the course host answers {string} with {string}", (_ctx, courseId: string) => {
      const body = MALFORMED_BODIES[variables.body];
      expect(body, `no malformed body called "${variables.body}"`).toBeDefined();
      host.answer(courseId, new Response(body));
    });
    When("the reader loads the course {string}", load);
    Then("the load shall fail with an error", () => {
      expect(failure).toBeInstanceOf(Error);
    });
    And("the reader shall log the error {string}", logged);
    And("the reader shall not cache a course for {string}", notCached);
  });

  Scenario("Database query failure", ({ Given, And, When, Then }) => {
    let catalogue: unknown[];

    Given("the catalogue holds {number} courses", async (_ctx, count: number) => {
      failing.clear();
      await database.reset();
      for (let i = 0; i < count; i++) await recordCourseVisit(sql, `course-${i + 1}`, { title: `Course ${i + 1}` }, new Date(`2026-07-0${i + 1}T00:00:00Z`));
    });
    And("the database answers queries on {string} with the error {string}", (_ctx, table: string, message: string) => {
      failing.set(table, message);
    });
    When("the catalogue is read", async () => {
      catalogue = await catalogueService.getCatalogue();
    });
    Then("the catalogue shall fall back to an empty list", () => {
      expect(catalogue).toEqual([]);
    });
    And("the course count shall fall back to {number}", async (_ctx, count: number) => {
      expect(await catalogueService.getCatalogueCount()).toBe(count);
    });
    // The entry's message only: the logger drops the database error's own text (see guides/specifications/error-handling.md).
    And("the catalogue service shall log the error {string}", logged);
    When("the database recovers and the catalogue is read again", async () => {
      failing.clear();
      catalogue = await catalogueService.getCatalogue();
    });
    Then("the catalogue shall list {number} courses", (_ctx, count: number) => {
      expect(catalogue).toHaveLength(count);
    });
  });
});
