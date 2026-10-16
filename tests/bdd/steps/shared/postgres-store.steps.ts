import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect, vi } from "vitest";

// The seams: Supabase (as server-data-access mocks it), the environments, SvelteKit, and the `pg`
// driver, whose Pool is the PGlite database below, so the reader composes store-postgres for real.
vi.mock("../../../../packages/adapters/driven/store-supabase/node_modules/@supabase/supabase-js/dist/index.mjs", async () => ({
  createClient: (await import("../../support/supabase-recorder.ts")).createClient
}));
vi.mock("@supabase/supabase-js", async () => ({ createClient: (await import("../../support/supabase-recorder.ts")).createClient }));
vi.mock("$app/env/public", async () => {
  const { publicEnv } = await import("../../support/supabase-recorder.ts");
  const { READER_ORIGIN } = await import("../../support/reader-api.ts");
  return Object.assign(publicEnv, { PUBLIC_READER_URL: READER_ORIGIN });
});
vi.mock("$app/env/private", async () => (await import("../../support/supabase-recorder.ts")).privateEnv);
vi.mock("$app/env", () => ({ browser: true, building: false, goto: vi.fn() }));
const store = vi.hoisted(() => ({ sql: undefined as unknown, pools: [] as string[] }));
vi.mock("pg", () => {
  class Pool {
    constructor(config: { connectionString: string }) {
      store.pools.push(config.connectionString);
      const sql = store.sql as { query: (...args: unknown[]) => unknown; end: () => unknown };
      return { query: (...args: unknown[]) => sql.query(...args), end: () => sql.end(), on: () => this };
    }
  }
  return { Pool, default: { Pool } };
});

import type { Course } from "../../../../packages/jsr/model/src/tutors.ts";
import {
  accessStoreContract,
  assistanceStoreContract,
  feedbackStoreContract,
  insightsReadContract,
  learningEventSinkContract,
  playgroundSnapshotsContract,
  profileContract,
  scormRecordsContract,
  snippetStoreContract,
  type ContractCase
} from "@tutors/application/testing";
import type { InsightsRead, PlaygroundSnapshots } from "@tutors/application/ports";
import type { HelpRequest } from "@tutors/domain/assistance";
import type { Annotation, Reflection } from "@tutors/domain/feedback";
import {
  migrate,
  postgresAccessStore,
  postgresAssistanceStore,
  postgresFeedbackStore,
  postgresInsightsRead,
  postgresLearningEventSink,
  postgresPlaygroundSnapshotRows,
  postgresProfile,
  postgresScormRecords,
  postgresSnippetStore,
  type MigrationRun,
  type SqlClient
} from "@tutors/store-postgres";
import { freshBrowser, githubUser, labsOf, publishedCourse, signIn } from "../../support/connect.ts";
import { readerRequest } from "../../support/reader-api.ts";
import { privateEnv, recorder } from "../../support/supabase-recorder.ts";
import { committedMigrations, pgliteDatabase } from "../../../support/postgres-store.ts";

const feature = await loadFeature("tests/bdd/features/shared/postgres-store.feature");

/**
 * The insights views over rows the Assistance and Feedback stores kept: the contract's rows go in
 * through those stores, which give them UUIDs, and are read back under the contract's own ids.
 */
async function seededInsightsRead(sql: SqlClient, rows: { requests: HelpRequest[]; annotations: Annotation[]; reflections: Reflection[] }): Promise<InsightsRead> {
  const ids = new Map<string, string>();
  const assistance = postgresAssistanceStore(sql);
  const feedback = postgresFeedbackStore(sql);
  for (const { id, ...request } of rows.requests) ids.set((await assistance.open(request)).id, id);
  for (const { id, revokedAt, ...annotation } of rows.annotations) {
    const kept = await feedback.annotate(annotation);
    if (revokedAt) await feedback.revoke(kept.id, revokedAt);
    ids.set(kept.id, id);
  }
  for (const { id, ...reflection } of rows.reflections) ids.set((await feedback.reflect(reflection)).id, id);
  const read = postgresInsightsRead(sql);
  const named = <T extends { id: string }>(found: T[]) => found.map((row) => ({ ...row, id: ids.get(row.id) ?? row.id }));
  return {
    helpRequests: async (courseId, period) => named(await read.helpRequests(courseId, period)),
    annotations: async (courseId, period) => named(await read.annotations(courseId, period)),
    reflections: async (courseId, period) => named(await read.reflections(courseId, period))
  };
}

/** Every table store-postgres reads or writes. */
const STORE_TABLES = [
  "tutors-connect-users",
  "tutors-connect-profiles",
  "tutors-connect-courses",
  "tutors-connect-latest",
  "learning_records",
  "calendar",
  "tutors_content_locks",
  "whiteboard_scenes",
  "course_gists",
  "scorm_records",
  "playground_snapshots",
  "app_errors",
  "assignments",
  "assignments_submissions",
  "assistance_requests"
];

const DATABASE_URL = "postgres://tutors@db.invalid/tutors";

// Opened before any scenario stubs the browser's globals (PGlite would take a stubbed `window` for a browser).
const db = await pgliteDatabase();
store.sql = db.sql;

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

describeFeature(feature, ({ Background, AfterEachScenario, Rule }) => {
  let course: Course;
  let response: Response;
  let run: MigrationRun | undefined;
  let failure: Error | undefined;

  const firstLab = () => labsOf(course)[0];
  /** An empty database with db/migrations applied, as `pnpm db:migrate` leaves a new one. */
  const freshDatabase = async () => {
    await db.sql.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await applyCommitted();
    store.pools.length = 0;
  };
  const applyCommitted = () => migrate(db.sql, committedMigrations());
  const supabaseUntouched = () => {
    expect(recorder.tableCalls).toEqual([]);
    expect(recorder.rpcCalls).toEqual([]);
  };
  const deployed = (_ctx: unknown, dataStore: string) => {
    privateEnv.DATA_STORE = dataStore;
    privateEnv.PRIVATE_DATABASE_URL = DATABASE_URL;
  };
  const signedIn = async (_ctx: unknown, name: string) => {
    await signIn(githubUser(name));
    recorder.tableCalls.length = 0;
    recorder.rpcCalls.length = 0;
  };
  const postPageLoad = async (_ctx: unknown, courseId: string) => {
    expect(course.courseId).toBe(courseId);
    response = await readerRequest("POST", "/api/analytics", { kind: "page-load", courseId, loId: firstLab().route, loType: "lab", day: today() });
    expect(response.status).toBe(204);
  };
  const tables = async () => (await db.sql.query<{ name: string }>(`SELECT tablename AS name FROM pg_tables WHERE schemaname = current_schema()`)).rows.map((r) => r.name);

  AfterEachScenario(() => {
    privateEnv.DATA_STORE = "";
    privateEnv.PRIVATE_DATABASE_URL = "";
  });

  Background(({ Given }) => {
    Given("the course {string} is published with {number} labs and {string} as its educator", async (_ctx, courseId: string, labs: number, educator: string) => {
      freshBrowser();
      course = publishedCourse(courseId, labs, {}, { educators: [educator], whitelist: [], students: [] });
      await freshDatabase();
    });
  });

  Rule(
    "Tutors shall keep the schema of the Postgres store as plain SQL migrations under db/migrations that create every table the store reads and writes, with no row-level security, policy, role or Supabase auth schema.",
    ({ RuleScenario }) => {
      RuleScenario("The migrations build the store on an empty database", ({ When, Then, And }) => {
        When("the migrations under db/migrations are applied to an empty Postgres database", async () => {
          // The Background's database was migrated the way `pnpm db:migrate` does it.
          expect((await db.sql.query<{ name: string }>("SELECT name FROM schema_migrations ORDER BY name")).rows.map((r) => r.name)).toEqual(
            committedMigrations().map((m) => m.name)
          );
        });
        Then("every table the Postgres store reads and writes exists", async () => {
          expect(await tables()).toEqual(expect.arrayContaining(STORE_TABLES));
        });
        And("no table has row-level security or a policy", async () => {
          const secured = await db.sql.query(`SELECT relname FROM pg_class WHERE relrowsecurity AND relnamespace = current_schema()::regnamespace`);
          expect(secured.rows).toEqual([]);
          expect((await db.sql.query(`SELECT policyname FROM pg_policies`)).rows).toEqual([]);
        });
        And("no migration names a Supabase role or the auth schema", () => {
          for (const m of committedMigrations()) {
            const code = m.sql.replace(/--.*$/gm, "");
            expect(code, m.name).not.toMatch(/\b(anon|authenticated|service_role)\b|\bauth\.|ROW LEVEL SECURITY|CREATE POLICY|\bGRANT\b|\bREVOKE\b/i);
          }
        });
      });
    }
  );

  Rule(
    "Where a server is deployed with DATA_STORE set to postgres, the reader shall read and write student data in the Postgres database at PRIVATE_DATABASE_URL instead of Supabase.",
    ({ RuleScenario }) => {
      RuleScenario("A lab visit on a Postgres deployment is stored in Postgres", ({ Given, And, When, Then }) => {
        Given("the reader's server is deployed with DATA_STORE {string} and a database URL", deployed);
        And("{string} is signed in to the reader", signedIn);
        When("the browser posts a page load of the first lab of {string}", postPageLoad);
        Then("the Postgres database holds the learning record and calendar row of {string}", async (_ctx, login: string) => {
          const records = await db.sql.query(`SELECT student_id, lo_id, count FROM learning_records`);
          expect(records.rows).toEqual([{ student_id: login, lo_id: firstLab().route, count: expect.anything() }]);
          expect(Number(records.rows[0].count)).toBe(1);
          const calendar = await db.sql.query(`SELECT studentid, courseid, id::text AS day FROM calendar`);
          expect(calendar.rows).toEqual([{ studentid: login, courseid: course.courseId, day: today() }]);
          expect(store.pools).toContain(DATABASE_URL);
        });
        And("nothing was read from or written to Supabase's tables", supabaseUntouched);
      });

      RuleScenario("A lab visit on a deployment without DATA_STORE is stored in Supabase", ({ Given, And, When, Then }) => {
        Given("the reader's server is deployed with DATA_STORE {string} and a database URL", deployed);
        And("{string} is signed in to the reader", signedIn);
        When("the browser posts a page load of the first lab of {string}", postPageLoad);
        Then("Supabase recorded the page load of {string}", (_ctx, login: string) => {
          expect(recorder.rpcCalls.filter((c) => c.fn === "record_page_view").map((c) => c.args.p_student_id)).toEqual([login]);
        });
        And("the Postgres database holds no learning record", async () => {
          expect((await db.sql.query(`SELECT 1 FROM learning_records`)).rows).toEqual([]);
        });
      });
    }
  );

  Rule("Tutors shall hold the Postgres store to the same contract suites as the Supabase and in-memory stores for every store port.", ({ RuleScenario }) => {
    RuleScenario("The Postgres store keeps every store port's contract", ({ When, Then }) => {
      const failures: string[] = [];
      When(
        "the contract suites of ProfilePort, AccessStore, LearningEventSink, ScormRecords, SnippetStore, PlaygroundSnapshots, AssistanceStore, FeedbackStore and InsightsRead run against the Postgres store",
        async () => {
          const sql: SqlClient = db.sql;
          const rows = postgresPlaygroundSnapshotRows(sql);
          const snapshots = (): PlaygroundSnapshots => ({
            available: async () => true,
            reviews: async () => true,
            save: async (s) => (await rows.save(s), true),
            get: async (courseId, loId, studentId) => (await rows.list(courseId, loId, studentId))[0] ?? null,
            list: (courseId, loId) => rows.list(courseId, loId, null),
            remove: (courseId, loId, studentId) => rows.remove(courseId, loId, studentId)
          });
          const suites: ContractCase[] = [
            ...profileContract(() => postgresProfile(sql)),
            ...accessStoreContract(() => postgresAccessStore(sql)),
            ...learningEventSinkContract(() => postgresLearningEventSink(sql)),
            ...scormRecordsContract(() => postgresScormRecords(sql)),
            ...snippetStoreContract(() => postgresSnippetStore(sql), new Date().toISOString()),
            ...playgroundSnapshotsContract(snapshots),
            ...assistanceStoreContract(() => postgresAssistanceStore(sql)),
            ...feedbackStoreContract(() => postgresFeedbackStore(sql)),
            ...insightsReadContract((rows) => seededInsightsRead(sql, rows))
          ];
          expect(suites.length).toBeGreaterThan(20);
          for (const c of suites) {
            await db.reset();
            await c.run().catch((error: Error) => failures.push(`${c.name}: ${error.message}`));
          }
        }
      );
      Then("every case passes", () => {
        expect(failures).toEqual([]);
      });
    });
  });

  Rule(
    "If a server is deployed with DATA_STORE set to postgres but without PRIVATE_DATABASE_URL, then the reader shall answer 503 to each of its data routes and read or write no row.",
    ({ RuleScenario }) => {
      RuleScenario("A Postgres deployment with no database URL", ({ Given, And, When, Then }) => {
        Given("{string} is signed in to the reader", signedIn);
        And("the reader's server is deployed with DATA_STORE {string} and no database URL", (_ctx, dataStore: string) => {
          privateEnv.DATA_STORE = dataStore;
          privateEnv.PRIVATE_DATABASE_URL = "";
          store.pools.length = 0;
        });
        When("the browser asks the reader for the content locks of {string}", async (_ctx, courseId: string) => {
          response = await readerRequest("GET", `/api/locks?${new URLSearchParams({ courseId })}`);
        });
        Then("the reader answers {int}", (_ctx, status: number) => {
          expect(response.status).toBe(status);
          expect(store.pools).toEqual([]);
        });
        And("nothing was read from or written to Supabase's tables", supabaseUntouched);
      });
    }
  );

  Rule(
    "When the migration command runs against a Postgres database, tutors shall apply in name order only the migrations not yet recorded there, each in one transaction that a failure rolls back.",
    ({ RuleScenario }) => {
      RuleScenario("A second run applies nothing", ({ Given, When, Then }) => {
        Given("the migrations under db/migrations were applied to an empty Postgres database", async () => {
          expect((await db.sql.query("SELECT count(*)::int AS n FROM schema_migrations")).rows[0].n).toBe(committedMigrations().length);
        });
        When("the migrations under db/migrations are applied again", async () => {
          run = await applyCommitted();
        });
        Then("no migration is applied a second time", () => {
          expect(run).toEqual({ applied: [], skipped: committedMigrations().map((m) => m.name) });
        });
      });

      RuleScenario("A failing migration leaves nothing behind and stops the run", ({ Given, When, Then, And }) => {
        Given("the migrations under db/migrations were applied to an empty Postgres database", async () => {
          expect((await db.sql.query("SELECT count(*)::int AS n FROM schema_migrations")).rows[0].n).toBe(committedMigrations().length);
        });
        When("a migration that creates a table and then fails is applied, followed by one more", async () => {
          failure = undefined;
          await migrate(db.sql, [
            ...committedMigrations(),
            { name: "29990101000000_half_done.sql", sql: "CREATE TABLE half_done (id int);\nSELECT 1 / 0;" },
            { name: "29990101000100_after.sql", sql: "CREATE TABLE after_half_done (id int);" }
          ]).catch((error: Error) => (failure = error));
        });
        Then("the run fails naming the failing migration", () => {
          expect(failure?.message).toMatch(/^migration 29990101000000_half_done\.sql failed: division by zero/);
        });
        And("the failing migration's table does not exist", async () => {
          expect(await tables()).not.toContain("half_done");
          expect(await tables()).not.toContain("after_half_done");
        });
        And("neither new migration is recorded", async () => {
          expect((await db.sql.query<{ name: string }>("SELECT name FROM schema_migrations WHERE name LIKE '2999%'")).rows).toEqual([]);
        });
      });
    }
  );
});
