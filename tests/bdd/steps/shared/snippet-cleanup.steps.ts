import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { afterAll, expect } from "vitest";
import { purgeExpiredSnippets } from "@tutors/store-postgres";
import { testDatabase, type TestDatabase } from "../../../support/postgres-store.ts";

const feature = await loadFeature("tests/bdd/features/shared/snippet-cleanup.feature");

/** The moment the cleanup runs: snippets are stamped either side of it. */
const NOW = "2026-10-16T12:00:00.000Z";

/** Opened at import, so a scenario's first step never waits for the database to start. */
const db: TestDatabase = await testDatabase();
afterAll(() => db.close());

describeFeature(feature, ({ Rule, AfterEachScenario }) => {
  let reported = 0;

  AfterEachScenario(async () => {
    await db.reset();
  });

  const holds = async (_ctx: unknown, expired: number, live: number) => {
    await db.sql.query(
      `INSERT INTO course_gists (course_id, student_id, content, expires_at)
       SELECT 'web-dev-101', 'student-' || g, 'print(' || g || ')', timestamptz '${NOW}' + (g - $1::int) * interval '1 hour'
         FROM generate_series(1, $2::int) g`,
      [expired, expired + live]
    );
  };
  const left = async () => (await db.sql.query<{ expires_at: Date }>("SELECT expires_at FROM course_gists")).rows;

  Rule("When the snippet cleanup runs, tutors shall delete from the store every snippet whose expiry has passed and keep every other snippet.", ({ RuleScenario }) => {
    RuleScenario("Expired snippets go and the rest stay", ({ Given, When, Then, And }) => {
      Given("the store holds {number} snippets that have expired and {number} that have not", holds);
      When("the snippet cleanup runs in batches of {number}", async (_ctx, batchSize: number) => {
        reported = await purgeExpiredSnippets(db.sql, NOW, { batchSize });
      });
      Then("the cleanup reports {number} snippets deleted", (_ctx, count: number) => expect(reported).toBe(count));
      And("the store holds the {number} snippets that have not expired", async (_ctx, count: number) => {
        const rows = await left();
        expect(rows).toHaveLength(count);
        for (const row of rows) expect(new Date(row.expires_at).getTime()).toBeGreaterThan(Date.parse(NOW));
      });
    });

    RuleScenario("A dry run deletes nothing", ({ Given, When, Then, And }) => {
      Given("the store holds {number} snippets that have expired and {number} that have not", holds);
      When("the snippet cleanup runs as a dry run", async () => {
        reported = await purgeExpiredSnippets(db.sql, NOW, { dryRun: true });
      });
      Then("the cleanup reports {number} snippets deleted", (_ctx, count: number) => expect(reported).toBe(count));
      And("the store holds {number} snippets", async (_ctx, count: number) => expect(await left()).toHaveLength(count));
    });
  });
});
