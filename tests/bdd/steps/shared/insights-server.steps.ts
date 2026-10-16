/**
 * Learning insights on the reader's server (Rules 0416, 0417): the reader's GET /api/insights over a
 * Postgres database (PGlite) holding the assistance and feedback tables and the insights views.
 */
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect, vi } from "vitest";

// The seams: the environments (a signed-in deployment, backend.ts), SvelteKit, and the `pg`
// driver, whose Pool is the PGlite database below. Every query the routes make is
// recorded, so a scenario can say which ones read the insights views.
vi.mock("$app/env/public", async () => {
  const { publicEnv } = await import("../../support/backend.ts");
  const { READER_ORIGIN } = await import("../../support/reader-api.ts");
  return Object.assign(publicEnv, { PUBLIC_READER_URL: READER_ORIGIN });
});
vi.mock("$app/env/private", async () => (await import("../../support/backend.ts")).privateEnv);
vi.mock("$app/env", () => ({ browser: true, building: false, goto: vi.fn() }));
const database = vi.hoisted(() => ({ sql: undefined as unknown, queries: [] as { text: string; params: unknown[] }[] }));
vi.mock("pg", () => {
  class Pool {
    query(text: string, params: unknown[] = []) {
      database.queries.push({ text, params });
      return (database.sql as { query: (...a: unknown[]) => unknown }).query(text, params);
    }
    end() {
      return Promise.resolve();
    }
    on() {
      return this;
    }
  }
  return { Pool, default: { Pool } };
});

import type { Course } from "../../../../packages/jsr/model/src/tutors.ts";
import { createDataApi, readerApiInsightsDesk } from "@tutors/data-api";
import { migrate } from "@tutors/store-postgres";
import { freshBrowser, githubUser, labsOf, publishedCourse } from "../../support/connect.ts";
import { readerRequest, setReaderSession } from "../../support/reader-api.ts";
import { committedMigrations, pgliteDatabase } from "../../../support/postgres-store.ts";
import { t } from "../../../../packages/adapters/driving/i18n/src/index.ts";
import { REFUSAL_MESSAGES } from "../../../../apps/time/src/lib/components/insights/format.ts";

const feature = await loadFeature("tests/bdd/features/shared/insights-server.feature");

// Opened before any scenario stubs the browser's globals (PGlite would take a stubbed `window` for a browser).
const db = await pgliteDatabase();
database.sql = db.sql;

describeFeature(feature, ({ Background, Rule, AfterEachScenario }) => {
  let course: Course;
  let response: Response;
  let body: Record<string, unknown>;

  const firstLab = () => labsOf(course)[0].route;
  const as = (name: string | null) => setReaderSession(name ? githubUser(name) : null);
  const insightsQueries = () => database.queries.filter((q) => /\binsights_/.test(q.text));

  AfterEachScenario(() => {
    as(null);
  });

  Background(({ Given }) => {
    Given("the course {string} is published with {number} lab and {string} as its educator", async (_ctx, courseId: string, labs: number, educator: string) => {
      await freshBrowser();
      course = publishedCourse(courseId, labs, {}, { educators: [educator], whitelist: [], students: [] });
      await db.sql.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
      await migrate(db.sql, committedMigrations());
    });
  });

  const askedForHelp = async (_ctx: unknown, count: number, stepId: string, day: string) => {
    for (let i = 0; i < count; i++) {
      const requested = `${day}T09:0${i}:00.000Z`;
      await db.sql.query(
        `INSERT INTO assistance_requests (course_id, lab_route, step_id, learner_id, learner_name, kind, state, requested_at, acknowledged_by, acknowledged_at, hint_text)
         VALUES ($1, $2, $3, $4, $5, 'stuck', 'acknowledged', $6::timestamptz, 'ellen', $6::timestamptz + make_interval(mins => $7), 'a hint')`,
        [course.courseId, firstLab(), stepId, `student-${i + 1}`, `Student ${i + 1}`, requested, i + 1]
      );
    }
  };
  const reads = async (_ctx: unknown, login: string, courseId: string, span: string, day: string) => {
    as(login);
    database.queries.length = 0;
    response = await readerRequest("GET", `/api/insights?${new URLSearchParams({ courseId, span, day })}`);
    body = (await response.json()) as Record<string, unknown>;
  };
  const readsDay = (ctx: unknown, login: string, courseId: string, day: string) => reads(ctx, login, courseId, "day", day);
  const answersWith = (_ctx: unknown, status: number, reason: string) => {
    expect([response.status, body.reason]).toEqual([status, reason]);
  };

  Rule(
    "If the insights views are missing in the database, then tutors shall show the insights pages empty with one message and keep the rest of Time working.",
    ({ RuleScenario }) => {
      RuleScenario("A database without the insights views", ({ Given, And, When, Then }) => {
        Given("{number} students asked for help at the step {string} of the first lab on {string}", askedForHelp);
        And("the database has no insights views", async () => {
          await db.sql.query("DROP VIEW insights_help_requests; DROP VIEW insights_annotations; DROP VIEW insights_reflections;");
        });
        When("{string} reads the insights of {string} for the day {string}", readsDay);
        Then("the reader shall answer {number} with the reason {string}", answersWith);
        And("the insights page shall show the one message for {string}", async (_ctx, reason: string) => {
          const answer = await readerApiInsightsDesk(createDataApi()).course(course.courseId, "day", "2026-01-05");
          expect(answer).toEqual({ ok: false, reason });
          expect(t(REFUSAL_MESSAGES[reason as keyof typeof REFUSAL_MESSAGES])).toBe("Insights are not set up on this server yet. The rest of Tutors Time works as usual.");
        });
        And("the course's time rows shall still be read for {string}", async (_ctx, login: string) => {
          as(login);
          const time = await readerRequest("GET", `/api/time/${course.courseId}`);
          expect(time.status).toBe(200);
        });
      });
    }
  );

  Rule("Tutors shall read insights with date-filtered, indexed queries bounded to the chosen period, as Rule 0319 requires of the calendar.", ({ RuleScenario }) => {
    RuleScenario("Every insights read names the course and the period, over an index that leads with them", ({ Given, And, When, Then }) => {
      Given("{number} students asked for help at the step {string} of the first lab on {string}", askedForHelp);
      And("{string} has broadcast an explanation on the step {string} of the first lab on {string}", async (_ctx, author: string, stepId: string, day: string) => {
        await db.sql.query(
          `INSERT INTO feedback_annotations (course_id, lab_route, step_id, anchor_kind, audience, body, author_id, created_at) VALUES ($1, $2, $3, 'step', 'everyone', 'Await it.', $4, $5::timestamptz)`,
          [course.courseId, firstLab(), stepId, author, `${day}T12:00:00.000Z`]
        );
      });
      When("{string} reads the insights of {string} for 7 days ending {string}", (ctx, login: string, courseId: string, day: string) => reads(ctx, login, courseId, "week", day));
      Then("the reader shall answer {number} with the step {string} first", (_ctx, status: number, stepId: string) => {
        expect(response.status).toBe(status);
        const insights = body.insights as { steps: { ref: { stepId: string }; total: number; annotations: number }[] };
        expect(insights.steps.map((s) => [s.ref.stepId, s.total, s.annotations])).toEqual([[stepId, 5, 1]]);
      });
      And("every insights query shall filter on the course and on the period from {string} to {string}", (_ctx, from: string, to: string) => {
        const queries = insightsQueries();
        expect(queries.map((q) => q.text.match(/FROM (insights_\w+)/)?.[1]).sort()).toEqual(["insights_annotations", "insights_help_requests", "insights_reflections"]);
        for (const q of queries) {
          expect(q.text).toMatch(/WHERE course_id = \$1 AND (\w+) >= \$2::timestamptz AND \1 < \$3::timestamptz/);
          expect(q.params).toEqual([course.courseId, from, to]);
        }
      });
      And("each view's table shall have an index on the course and the time it filters on", async () => {
        const { rows } = await db.sql.query<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE schemaname = 'public'`);
        const defs = rows.map((r) => r.indexdef);
        for (const [table, column] of [
          ["assistance_requests", "requested_at"],
          ["feedback_annotations", "created_at"],
          ["feedback_reflections", "shared_at"]
        ])
          expect(defs.some((d) => d.includes(`ON public.${table}`) && d.includes(`(course_id, ${column})`)), table).toBe(true);
      });
      And("no insights query shall read a body, a hint or a student's name", () => {
        const text = insightsQueries().map((q) => q.text).join("\n");
        expect(text).not.toMatch(/\bbody\b|hint_text|learner_name/);
        expect(JSON.stringify(body)).not.toMatch(/a hint|Student 1|Await it/);
      });
    });

    RuleScenario("A student is refused before any row is read", ({ Given, When, Then, And }) => {
      Given("{number} students asked for help at the step {string} of the first lab on {string}", askedForHelp);
      When("{string} reads the insights of {string} for the day {string}", readsDay);
      Then("the reader shall answer {number} with the reason {string}", answersWith);
      And("no insights query shall have been made", () => expect(insightsQueries()).toEqual([]));
    });
  });
});
