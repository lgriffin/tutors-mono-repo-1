import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tutors/logger", () => ({
  default: { error: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), setDefaultLevel: vi.fn() }
}));

import { postgresCatalogue, type SqlClient } from "@tutors/store-postgres";
import log from "@tutors/logger";
import { testDatabase, type TestDatabase } from "../../support/postgres-store.ts";

// The reader server's composition root's job: the store adapter is given the database it opened.
let db: TestDatabase;
beforeAll(async () => {
  db = await testDatabase();
}, 60_000);
afterAll(() => db.close());

/** A database that refuses every query, as one that is down does. */
const down = (message: string): SqlClient => ({
  query: () => Promise.reject(new Error(message)),
  end: async () => {}
});

async function seedCourses(...entries: { course_id: string; visited_at?: string; visit_count?: number }[]) {
  for (const entry of entries) {
    await db.sql.query(`INSERT INTO "tutors-connect-courses" (course_id, visited_at, visit_count, course_record) VALUES ($1, $2, $3, $4::jsonb)`, [
      entry.course_id,
      entry.visited_at ?? "2026-07-01T00:00:00Z",
      entry.visit_count ?? 5,
      JSON.stringify({ title: "Test Course" })
    ]);
  }
}

async function seedProfiles(...tutorIds: string[]) {
  for (const tutorId of tutorIds) await db.sql.query(`INSERT INTO "tutors-connect-profiles" ("tutorId", profile) VALUES ($1, '[]'::jsonb)`, [tutorId]);
}

beforeEach(async () => {
  vi.clearAllMocks();
  await db.reset();
});

describe("catalogueService.getCatalogue", () => {
  it("returns all catalogue entries ordered by visited_at descending", async () => {
    await seedCourses({ course_id: "old", visited_at: "2026-01-01T00:00:00Z" }, { course_id: "new", visited_at: "2026-07-01T00:00:00Z" });

    const result = await postgresCatalogue(db.sql).getCatalogue();

    expect(result).toEqual([
      { course_id: "new", visited_at: "2026-07-01T00:00:00.000Z", visit_count: 5, course_record: { title: "Test Course" } },
      { course_id: "old", visited_at: "2026-01-01T00:00:00.000Z", visit_count: 5, course_record: { title: "Test Course" } }
    ]);
  });

  it("returns empty array when no courses exist", async () => {
    expect(await postgresCatalogue(db.sql).getCatalogue()).toEqual([]);
  });

  it("returns empty array and logs error when the database fails", async () => {
    const result = await postgresCatalogue(down("DB down")).getCatalogue();

    expect(result).toEqual([]);
    expect(log.error).toHaveBeenCalledWith("Reading the catalogue failed:", { what: "courses", error: expect.objectContaining({ message: "DB down" }) });
  });
});

describe("catalogueService.getCatalogueCount", () => {
  it("returns the count of courses", async () => {
    await seedCourses({ course_id: "c1" }, { course_id: "c2" }, { course_id: "c3" });

    expect(await postgresCatalogue(db.sql).getCatalogueCount()).toBe(3);
  });

  it("returns 0 when no courses exist", async () => {
    expect(await postgresCatalogue(db.sql).getCatalogueCount()).toBe(0);
  });

  it("returns 0 and logs error when the database fails", async () => {
    const result = await postgresCatalogue(down("fail")).getCatalogueCount();

    expect(result).toBe(0);
    expect(log.error).toHaveBeenCalledWith("Reading the catalogue failed:", { what: "course count", error: expect.objectContaining({ message: "fail" }) });
  });
});

describe("catalogueService.getStudentCount", () => {
  it("returns the number of student profiles", async () => {
    await seedProfiles("alice", "bob");

    expect(await postgresCatalogue(db.sql).getStudentCount()).toBe(2);
  });

  it("counts without reading any profile row", async () => {
    await seedProfiles("alice", "bob");
    const texts: string[] = [];
    const watched: SqlClient = { query: (text, params) => (texts.push(text), db.sql.query(text, params)), end: async () => {} };

    await postgresCatalogue(watched).getStudentCount();

    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatch(/SELECT count\(\*\)/i);
    expect(texts[0]).not.toMatch(/profile\s*,|SELECT\s+\*|"tutorId"/);
  });

  it("returns 0 when no profiles exist", async () => {
    expect(await postgresCatalogue(db.sql).getStudentCount()).toBe(0);
  });

  it("returns 0 and logs when the database fails", async () => {
    const result = await postgresCatalogue(down("no table")).getStudentCount();

    expect(result).toBe(0);
    expect(log.error).toHaveBeenCalledWith("Reading the catalogue failed:", { what: "student count", error: expect.objectContaining({ message: "no table" }) });
  });
});
