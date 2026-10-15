import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { afterAll, beforeAll, expect, vi } from "vitest";

// Supabase and the environments are the only stand-ins: the catalogue page's load function, the
// reader's GET /api/catalogue and the catalogue store it reads through are the real ones.
vi.mock("../../../../packages/adapters/driven/store-supabase/node_modules/@supabase/supabase-js/dist/index.mjs", async () => ({ createClient: (await import("../../support/supabase-recorder.ts")).createClient }));
vi.mock("@supabase/supabase-js", async () => ({ createClient: (await import("../../support/supabase-recorder.ts")).createClient }));
vi.mock("$app/env/public", async () => (await import("../../support/supabase-recorder.ts")).publicEnv);
vi.mock("$app/env/private", async () => (await import("../../support/supabase-recorder.ts")).privateEnv);

import log from "@tutors/logger";
import { flattenLos, type Composite, type Course, type Lo } from "../../../../packages/jsr/model/src/tutors.ts";
import { load as loadCataloguePage } from "../../../../apps/catalogue/src/routes/+page.ts";
import type { LoShape } from "../../../support/arbitraries/course-tree.ts";
import { labShape, loadCourse, shape } from "../../support/course.ts";
import { installReaderFetch, READER_ORIGIN, resetReaderApi } from "../../support/reader-api.ts";
import { privateEnv, publicEnv, recorder } from "../../support/supabase-recorder.ts";

const SERVICE_KEY = privateEnv.PRIVATE_SUPABASE_SERVICE_ROLE_KEY;

beforeAll(() => {
  recorder.reset();
  resetReaderApi();
  installReaderFetch();
  publicEnv.PUBLIC_READER_URL = READER_ORIGIN;
});
afterAll(() => {
  delete publicEnv.PUBLIC_READER_URL;
  privateEnv.PRIVATE_SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
  vi.unstubAllGlobals();
});

/** The catalogue page's data, loaded as the catalogue app loads it: from the reader's data API. */
const openCatalogue = () => loadCataloguePage({ fetch: globalThis.fetch } as Parameters<typeof loadCataloguePage>[0]) as Promise<{ courseRecords: CourseRecord[]; studentCount: number }>;

const feature = await loadFeature("tests/bdd/features/student/course-discovery.feature");

const list = (csv: string) => csv.split(",").map((item) => item.trim());

type CatalogueRow = { id: string; title: string; visits: string };
type CourseRecord = { id: string; title: string; credits: string; img: string; visits: number };

describeFeature(feature, ({ Rule }) => {
  Rule("When a student opens the catalogue, the catalogue shall list the courses with at least 20 visits, most visited first, each with its title, summary, image and visit count.", ({ RuleScenario }) => {
    RuleScenario("Browse available courses in catalogue", ({ Given, When, Then, And }) => {
      let rows: CatalogueRow[];
      let displayed: CourseRecord[];

      const record = (row: CatalogueRow) => ({ id: row.id, title: row.title, credits: `${row.title} team`, img: `https://${row.id}.netlify.app/course.png` });

      Given("the catalogue contains the courses:", (_ctx, table: CatalogueRow[]) => {
        rows = table;
        recorder.seed(
          "tutors-connect-courses",
          rows.map((row, i) => ({
            course_id: row.id,
            visited_at: `2026-09-0${i + 1}T09:00:00Z`,
            visit_count: Number(row.visits),
            course_record: record(row)
          }))
        );
      });
      When("a student opens the catalogue", async () => {
        displayed = (await openCatalogue()).courseRecords;
      });
      Then("the catalogue shall display the courses {string}", (_ctx, expected: string) => {
        // Established courses only (20 visits or more), most visited first.
        expect(displayed.map((course) => course.title)).toEqual(list(expected));
      });
      And("each course shall show its title, summary, image and visit count", () => {
        for (const course of displayed) {
          const row = rows.find((candidate) => candidate.id === course.id)!;
          // The catalogue card takes its summary from the course credits.
          expect(course).toEqual({ ...record(row), visits: Number(row.visits) });
        }
      });
    });
  });

  Rule("When a student filters a course by topic, the reader shall show only the learning objects of that topic.", ({ RuleScenario }) => {
    RuleScenario("Filter courses by topic", ({ Given, When, Then }) => {
      let course: Course;
      let shown: Lo[];

      Given("a course has topics {string} and {string}", (_ctx, first: string, second: string) => {
        const topic = (title: string): LoShape =>
          shape("topic", title, [labShape(`${title} Lab`, [{ title: "Setup", contentMd: "# Setup" }]), shape("note", `${title} Notes`)]);
        course = loadCourse("computing", "Computing", [topic(first), topic(second)]);
      });
      When("a student filters by topic {string}", (_ctx, topicTitle: string) => {
        const topics = [...course.topicIndex.values()].filter((topic) => topic.title === topicTitle);
        expect(topics).toHaveLength(1);
        shown = flattenLos(topics[0].los);
      });
      Then("the reader shall display only the learning objects {string}", (_ctx, expected: string) => {
        expect(shown.map((lo) => lo.title)).toEqual(list(expected));
      });
    });
  });

  Rule("When a student opens a course, the reader shall display its title, its summary and its topics in their published order.", ({ RuleScenario }) => {
    RuleScenario("View course details", ({ Given, And, When, Then }) => {
      let title: string;
      let topics: LoShape[];
      let course: Course;

      Given("a course {string} exists", (_ctx, courseTitle: string) => {
        title = courseTitle;
      });
      And("its topics {string} were published with the orders {string}", (_ctx, titles: string, orders: string) => {
        const order = list(orders);
        topics = list(titles).map((topicTitle, i) => shape("topic", topicTitle, [], order[i] === "none" ? {} : { order: Number(order[i]) }));
      });
      When("a student navigates to the course", () => {
        course = loadCourse("intro-computing", title, topics);
      });
      Then("the reader shall display the course title {string} and the summary {string}", (_ctx, expectedTitle: string, summaryHtml: string) => {
        expect(course.title).toBe(expectedTitle);
        expect(course.summary.trim()).toBe(summaryHtml);
      });
      And("the reader shall display the topics in the order {string}", (_ctx, expected: string) => {
        const composite = course as unknown as Composite;
        expect(composite.units.standardLos.map((lo) => lo.title)).toEqual(list(expected));
        expect(composite.toc.map((lo) => lo.title)).toEqual(list(expected));
      });
    });
  });

  Rule("If the reader's server has no database configured, then the catalogue shall show an empty catalogue and a student count of 0 without logging an error.", ({ RuleScenario }) => {
    RuleScenario("Open the catalogue when the reader has no database", ({ Given, When, Then, And }) => {
      let data: { courseRecords: CourseRecord[]; studentCount: number };
      let logError: ReturnType<typeof vi.spyOn>;

      Given("the reader's server has no service key", () => {
        privateEnv.PRIVATE_SUPABASE_SERVICE_ROLE_KEY = "";
        logError = vi.spyOn(log, "error");
      });
      When("a student opens the catalogue", async () => {
        data = await openCatalogue();
      });
      Then("the catalogue shall display no courses", () => {
        expect(data.courseRecords).toEqual([]);
      });
      And("the catalogue shall show a student count of 0", () => {
        expect(data.studentCount).toBe(0);
      });
      And("no error shall be logged", () => {
        try {
          expect(logError).not.toHaveBeenCalled();
        } finally {
          logError.mockRestore();
          privateEnv.PRIVATE_SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
        }
      });
    });
  });
});
