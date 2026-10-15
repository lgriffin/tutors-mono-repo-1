/**
 * The store-postgres adapters behind the application's ports, run through the same contract suites
 * as store-supabase and the in-memory adapters, on a real Postgres (TEST_DATABASE_URL, in CI) or
 * PGlite, with db/migrations applied. Beside the contracts: the reads and writes the reader's routes
 * call directly, in the shapes the Supabase adapter hands back, and what each does when the database
 * refuses.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  accessStoreContract,
  learningEventSinkContract,
  playgroundSnapshotsContract,
  profileContract,
  scormRecordsContract,
  snippetStoreContract,
  type ContractCase
} from "@tutors/application/testing";
import type { PlaygroundSnapshots } from "@tutors/application/ports";
import {
  checkPostgres,
  insertAppErrors,
  postgresAccessStore,
  postgresCatalogue,
  postgresLearningEventSink,
  postgresLearningRecords,
  postgresPlaygroundSnapshotRows,
  postgresProfile,
  postgresScormRecords,
  postgresSnippetStore,
  postgresWhiteboardStore,
  readRoster,
  recentErrorCounts,
  recordCourseVisit,
  StoreError,
  upsertLatest,
  type SqlClient
} from "@tutors/store-postgres";
import log from "@tutors/logger";
import { testDatabase, type TestDatabase } from "../../support/postgres-store.ts";

vi.mock("@tutors/logger", () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

let db: TestDatabase;
beforeAll(async () => {
  db = await testDatabase();
}, 60_000);
afterAll(() => db.close());

/** Each case starts from empty tables, so the suites run as they do against a fresh in-memory adapter. */
function contract(name: string, cases: ContractCase[]) {
  describe(name, () => {
    beforeEach(() => db.reset());
    for (const c of cases) it(c.name, c.run);
  });
}

/** A database that refuses every query, for the failure paths. */
const refusing: SqlClient = {
  query: async () => {
    throw new Error("connection refused");
  },
  end: async () => {}
};

/** The browser port over the server's rows, as an educator sees them: the route's decisions are not under test here. */
function snapshotsOverRows(sql: SqlClient): PlaygroundSnapshots {
  const rows = postgresPlaygroundSnapshotRows(sql);
  return {
    available: async () => true,
    reviews: async () => true,
    save: async (s) => (await rows.save(s), true),
    get: async (courseId, loId, studentId) => (await rows.list(courseId, loId, studentId))[0] ?? null,
    list: (courseId, loId) => rows.list(courseId, loId, null),
    remove: (courseId, loId, studentId) => rows.remove(courseId, loId, studentId)
  };
}

contract("ProfilePort: Postgres", profileContract(() => postgresProfile(db.sql)));
contract("AccessStore: Postgres", accessStoreContract(() => postgresAccessStore(db.sql)));
contract("LearningEventSink: Postgres", learningEventSinkContract(() => postgresLearningEventSink(db.sql)));
contract("ScormRecords: Postgres", scormRecordsContract(() => postgresScormRecords(db.sql)));
contract("SnippetStore: Postgres", snippetStoreContract(() => postgresSnippetStore(db.sql), new Date().toISOString()));
contract("PlaygroundSnapshots: Postgres rows", playgroundSnapshotsContract(() => snapshotsOverRows(db.sql)));

describe("learning records", () => {
  beforeEach(() => db.reset());
  const sink = () => postgresLearningEventSink(db.sql);
  const lab = { kind: "page-load" as const, courseId: "cs101", loId: "/lab/cs101/week-01", loType: "lab", day: "2026-09-21" };

  it("counts each page load as a visit and a 30-second block, and each tick as a block, as the Supabase functions do", async () => {
    await sink().record(lab, "ann");
    await sink().record(lab, "ann");
    await sink().record({ kind: "tick", courseId: "cs101", loId: lab.loId, day: lab.day }, "ann");
    await sink().record({ kind: "tick", courseId: "cs101", loId: null, day: lab.day }, "ann");

    const records = await postgresLearningRecords(db.sql).learningRecords("cs101", "ann");
    expect(records).toEqual([expect.objectContaining({ course_id: "cs101", student_id: "ann", lo_id: lab.loId, duration: 3, count: 2, type: "lab" })]);
    expect(Date.parse(records[0].date_last_accessed!)).not.toBeNaN();
    expect(await postgresLearningRecords(db.sql).calendarEntries("cs101", "2026-09-21", "2026-09-21")).toEqual([
      { id: "2026-09-21", studentid: "ann", courseid: "cs101", timeactive: 4, pageloads: 2 }
    ]);
  });

  it("records nothing without a learner, a course, or (for a page load) a learning object", async () => {
    await sink().record(lab, null as unknown as string);
    await sink().record({ ...lab, courseId: "" }, "ann");
    await sink().record({ ...lab, loId: "" }, "ann");
    expect(await postgresLearningRecords(db.sql).learningRecords("cs101", null as unknown as string)).toEqual([]);
  });

  it("a tick on a day with no page load changes nothing", async () => {
    await sink().record({ kind: "tick", courseId: "cs101", loId: lab.loId, day: lab.day }, "ann");
    expect(await postgresLearningRecords(db.sql).calendarEntries("cs101")).toEqual([]);
  });

  it("names the course's learners and reads Time's rows, with each assignment's submissions counted", async () => {
    await sink().record(lab, "ann");
    await sink().record({ ...lab, day: "2026-09-22" }, "bob");
    await postgresProfile(db.sql).upsertLearner({ login: "ann", name: "Ann", email: "ann@example.com", image: "https://avatars/ann.png", sentiment: null, sharing: true });
    await recordCourseVisit(db.sql, "cs101", { title: "CS 101" });
    await db.sql.query(`INSERT INTO assignments (id, courseid, name, due_date) VALUES (7, 'cs101', 'Lab 1', '2026-10-01T12:00:00Z'), (8, 'cs101', 'Lab 2', NULL), (9, 'cs102', 'Other', NULL)`);
    await db.sql.query(`INSERT INTO assignments_submissions (id, "assignmentId") VALUES (1, 7), (2, 7)`);

    expect((await postgresLearningRecords(db.sql).learners("cs101")).map((u) => [u.github_id, u.full_name])).toEqual([["ann", "Ann"]]);

    const rows = await postgresLearningRecords(db.sql).timeRows("cs101", "2026-09-22", null);
    expect(rows.course).toEqual({ course_id: "cs101", course_record: { title: "CS 101" } });
    expect(rows.calendar.map((r) => r.studentid)).toEqual(["bob"]);
    expect(rows.learningRecords.map((r) => r.student_id).sort()).toEqual(["ann", "bob"]);
    expect(rows.users).toEqual([expect.objectContaining({ github_id: "ann", full_name: "Ann", avatar_url: "https://avatars/ann.png" })]);
    expect(rows.users[0]).not.toHaveProperty("email");
    expect(rows.assignments).toEqual([
      { id: 7, name: "Lab 1", url: null, due_date: "2026-10-01T12:00:00.000Z", opened_date: null, submissionCount: 2 },
      { id: 8, name: "Lab 2", url: null, due_date: null, opened_date: null, submissionCount: 0 }
    ]);
  });

  it("answers every read empty for no course, and logs and answers empty when the database refuses", async () => {
    const empty = postgresLearningRecords(db.sql);
    expect(await empty.calendarEntries("")).toEqual([]);
    expect(await empty.learningRecords("")).toEqual([]);
    expect(await empty.learners("")).toEqual([]);
    expect((await empty.timeRows("")).calendar).toEqual([]);

    const down = postgresLearningRecords(refusing);
    expect(await down.calendarEntries("cs101")).toEqual([]);
    expect(await down.learningRecords("cs101")).toEqual([]);
    expect(await down.learners("cs101")).toEqual([]);
    await expect(down.timeRows("cs101")).rejects.toBeInstanceOf(StoreError);
    expect(log.error).toHaveBeenCalledWith("Reading learning records failed:", { what: "learners", error: expect.any(Error) });
  });

  it("fails a write the database refuses with a StoreError naming it", async () => {
    await expect(postgresLearningEventSink(refusing).record(lab, "ann")).rejects.toThrow("record page view: connection refused");
    await expect(postgresLearningEventSink(refusing).record({ kind: "tick", courseId: "cs101", loId: null, day: lab.day }, "ann")).rejects.toThrow("record heartbeat");
  });
});

describe("profiles", () => {
  beforeEach(() => db.reset());

  it("keeps the learner's chosen status when they sign in again and the session names them afresh", async () => {
    const profile = postgresProfile(db.sql);
    await profile.setSentiment("ann", "confused");
    await profile.upsertLearner({ login: "ann", name: "  ", email: null, image: null, sentiment: null, sharing: null });
    const { rows } = await db.sql.query(`SELECT full_name, sentiment FROM "tutors-connect-users"`);
    expect(rows).toEqual([{ full_name: "ann", sentiment: "confused" }]);
  });

  it("reads and writes nothing for no learner", async () => {
    const profile = postgresProfile(refusing);
    expect(await profile.getCourseVisits("")).toEqual([]);
    expect(await profile.getSentiment("")).toBeNull();
    expect(await profile.getSharing("")).toBeNull();
    await profile.saveCourseVisits("", []);
    await profile.setSentiment("", "fine");
    await profile.setSharing("", true);
    await profile.upsertLearner({ login: "", name: null, email: null, image: null, sentiment: null, sharing: null });
  });
});

describe("whiteboards", () => {
  beforeEach(() => db.reset());
  const room = { courseId: "cs101", route: "/lab/cs101/week-01", shared: false };

  it("keeps each learner's personal room apart, shares a shared room, and saves nothing for nobody", async () => {
    const store = postgresWhiteboardStore(db.sql);
    expect(await store.save(room, "ann", [{ id: "a" }])).toBe(true);
    expect(await store.save(room, "bob", [{ id: "b" }])).toBe(true);
    expect(await store.save(room, null, [{ id: "x" }])).toBe(false);
    expect(await store.save({ ...room, shared: true }, null, [{ id: "s" }])).toBe(true);
    expect((await store.load(room, "ann"))?.elements).toEqual([{ id: "a" }]);
    expect((await store.load(room, "bob"))?.appState).toEqual({ viewBackgroundColor: "#ffffff" });
    expect((await store.load({ ...room, shared: true }, "ann"))?.elements).toEqual([{ id: "s" }]);
    expect(await store.load(room, "carol")).toBeNull();
  });
});

describe("the catalogue, presence and the error log", () => {
  beforeEach(() => db.reset());

  it("counts visits per course, newest visit first, and students by their profiles", async () => {
    await recordCourseVisit(db.sql, "cs101", { title: "One" }, new Date("2026-09-01T00:00:00Z"));
    await recordCourseVisit(db.sql, "cs102", { title: "Two" }, new Date("2026-09-02T00:00:00Z"));
    await recordCourseVisit(db.sql, "cs101", { title: "One again" }, new Date("2026-09-03T00:00:00Z"));
    await postgresProfile(db.sql).saveCourseVisits("ann", []);

    const catalogue = postgresCatalogue(db.sql);
    expect(await catalogue.getCatalogue()).toEqual([
      { course_id: "cs101", visited_at: "2026-09-03T00:00:00.000Z", visit_count: 2, course_record: { title: "One again" } },
      { course_id: "cs102", visited_at: "2026-09-02T00:00:00.000Z", visit_count: 1, course_record: { title: "Two" } }
    ]);
    expect(await catalogue.getCatalogueCount()).toBe(2);
    expect(await catalogue.getStudentCount()).toBe(1);
  });

  it("answers the catalogue empty when the database refuses", async () => {
    const catalogue = postgresCatalogue(refusing);
    expect(await catalogue.getCatalogue()).toEqual([]);
    expect(await catalogue.getCatalogueCount()).toBe(0);
    expect(await catalogue.getStudentCount()).toBe(0);
  });

  it("keeps the latest snapshot per learner per course and reads the roster newest first since a time", async () => {
    await upsertLatest(db.sql, "ann", "cs101", { loRoute: "/a" }, new Date("2026-09-21T10:00:00Z"));
    await upsertLatest(db.sql, "ann", "cs101", { loRoute: "/b" }, new Date("2026-09-21T10:05:00Z"));
    await upsertLatest(db.sql, "bob", "cs101", { loRoute: "/c" }, new Date("2026-09-21T10:01:00Z"));
    await upsertLatest(db.sql, "carol", "cs102", null, new Date("2026-09-21T09:00:00Z"));

    expect(await readRoster(db.sql, "cs101", null)).toEqual([
      { course_id: "cs101", student_id: "ann", payload: { loRoute: "/b" }, received_at: "2026-09-21T10:05:00.000Z" },
      { course_id: "cs101", student_id: "bob", payload: { loRoute: "/c" }, received_at: "2026-09-21T10:01:00.000Z" }
    ]);
    expect((await readRoster(db.sql, null, "2026-09-21T10:02:00Z"))?.map((r) => r.student_id)).toEqual(["ann"]);
    expect((await readRoster(db.sql, null, null))?.length).toBe(3);
    expect(await readRoster(refusing, "cs101", null)).toBeNull();
    await expect(upsertLatest(refusing, "ann", "cs101", {})).rejects.toBeInstanceOf(StoreError);
  });

  it("logs errors in one insert and counts the last hour's per app and level", async () => {
    const row = (app: string, level: string) => ({ app, level, message: "boom", context: { n: 1 }, url: null, user_agent: null, course_id: null, student_id: null });
    await insertAppErrors(db.sql, []);
    await insertAppErrors(db.sql, [row("reader", "error"), row("reader", "error"), row("time", "warn")]);
    expect(await recentErrorCounts(db.sql)).toEqual([
      { app: "reader", level: "error", count: 2 },
      { app: "time", level: "warn", count: 1 }
    ]);
    expect(await recentErrorCounts(db.sql, 0)).toHaveLength(2);
    expect(await recentErrorCounts(null)).toEqual([]);
    expect(await recentErrorCounts(refusing)).toEqual([]);
    await expect(insertAppErrors(refusing, [row("reader", "error")])).rejects.toThrow("app_errors insert");
  });

  it("checks the database in one round trip, and says so when there is none or it is down", async () => {
    expect((await checkPostgres(db.sql)).status).toBe("ok");
    expect(await checkPostgres(null)).toEqual({ status: "skipped", latencyMs: 0, message: "no database client on this server" });
    expect(await checkPostgres(refusing)).toMatchObject({ status: "error", message: "connection refused" });
  });
});

describe("failure paths of the ports", () => {
  it("answers locks and SCORM state with nothing, and a snippet count with unknown, when the database refuses", async () => {
    const locks = postgresAccessStore(refusing);
    expect(await locks.locks("cs101")).toEqual([]);
    expect(await locks.setLock("cs101", "/x", true, "eve")).toBe(false);
    expect(await locks.removeLock("cs101", "/x")).toBe(false);
    expect(await locks.removeLock("", "/x")).toBe(false);

    const scorm = postgresScormRecords(refusing);
    expect(await scorm.load("cs101", "ann", "/scorm/x")).toEqual({});
    await scorm.save({ courseId: "cs101", learnerId: "ann", loId: "/scorm/x", version: "2004", cmi: {}, summary: { completionStatus: "unknown", successStatus: "unknown", totalTime: 0, location: "" } });
    expect(log.error).toHaveBeenCalledWith("upsertScormRecord failed:", expect.any(Error));

    const snippets = postgresSnippetStore(refusing);
    expect(await snippets.countSince("cs101", "ann", "2000-01-01T00:00:00Z")).toBeNull();
    expect(await snippets.active("", new Date().toISOString())).toEqual([]);
    await expect(snippets.active("cs101", new Date().toISOString())).rejects.toBeInstanceOf(StoreError);
  });

  it("shows each sharer's avatar and a default file name", async () => {
    await db.reset();
    await postgresProfile(db.sql).upsertLearner({ login: "ann", name: "Ann", email: null, image: "https://avatars/ann.png", sentiment: null, sharing: null });
    const store = postgresSnippetStore(db.sql);
    const later = new Date(Date.now() + 86_400_000).toISOString();
    await store.add({ courseId: "cs101", learnerId: "ann", learnerName: null, filename: null as unknown as string, content: "boom", title: null, loRoute: null, loTitle: null, expiresAt: later });
    expect((await store.active("cs101", new Date().toISOString())).map((r) => [r.avatarUrl, r.filename])).toEqual([["https://avatars/ann.png", "snippet.txt"]]);
  });
});
