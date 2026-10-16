/**
 * The snippet cleanup on the Postgres store (scripts/purge-course-gists.ts with PRIVATE_DATABASE_URL):
 * expired rows go, in batches, and a dry run deletes nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { purgeExpiredSnippets } from "@tutors/store-postgres";
import { testDatabase, type TestDatabase } from "../../support/postgres-store.ts";

const NOW = "2026-10-16T12:00:00.000Z";
let db: TestDatabase;

beforeEach(async () => {
  db = await testDatabase();
  await db.sql.query(
    `INSERT INTO course_gists (course_id, student_id, content, expires_at)
     SELECT 'web-dev-101', 'student-' || g, 'print(' || g || ')', timestamptz '${NOW}' + (g - 5) * interval '1 hour' FROM generate_series(1, 9) g`
  );
}, 60_000);

afterEach(async () => {
  await db.close();
});

const left = async () => (await db.sql.query<{ n: number }>("SELECT count(*)::int AS n FROM course_gists")).rows[0].n;

describe("purgeExpiredSnippets", { timeout: 60_000 }, () => {
  it("deletes every snippet expired at or before now, in batches, and keeps the rest", async () => {
    expect(await purgeExpiredSnippets(db.sql, NOW, { batchSize: 2 })).toBe(5);
    expect(await left()).toBe(4);
  });

  it("stops after the last batch it may run", async () => {
    expect(await purgeExpiredSnippets(db.sql, NOW, { batchSize: 2, maxBatches: 1 })).toBe(2);
    expect(await left()).toBe(7);
  });

  it("counts without deleting on a dry run", async () => {
    expect(await purgeExpiredSnippets(db.sql, NOW, { dryRun: true })).toBe(5);
    expect(await left()).toBe(9);
  });
});
