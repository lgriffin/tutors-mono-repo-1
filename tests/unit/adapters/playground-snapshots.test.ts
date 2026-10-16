/**
 * Playground snapshots, the only part of a playground that leaves the browser, on both sides of the
 * data API: the browser's adapter over /api/playground (which only asks: the server decides whose
 * rows the session may see, Rule 0475), and the server's rows in the Postgres store.
 */
import { afterAll, beforeAll, beforeEach, describe, it, expect, vi } from "vitest";
import { createDataApi, readerApiPlaygroundSnapshots } from "@tutors/data-api";
import { postgresPlaygroundSnapshotRows, type SqlClient } from "@tutors/store-postgres";
import { testDatabase, type TestDatabase } from "../../support/postgres-store.ts";

vi.mock("@tutors/logger", () => ({ default: { error: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

const snapshot = {
  studentId: "ada",
  studentName: "Ada Lovelace",
  courseId: "course.test",
  loId: "/playground/course.test/topic/hello",
  runtime: "python",
  entry: "main.py",
  files: [{ path: "main.py", content: "print(1)" }],
  lastOutput: "1\n",
  lastOk: true
};

const row = {
  student_id: "ada",
  student_name: "Ada Lovelace",
  course_id: "course.test",
  lo_id: "/playground/course.test/topic/hello",
  runtime: "python",
  entry: "main.py",
  files: [{ path: "main.py", content: "print(1)" }],
  last_output: "1\n",
  last_ok: true,
  updated_at: "2026-09-10T09:00:00.000Z"
};

describe("the browser's snapshots over /api/playground", () => {
  let calls: { url: string; init?: RequestInit }[];

  /** The adapter against a reader that answers every request with `status` and `body`. */
  function store(status = 200, body: unknown = { reviews: false, snapshots: [] }) {
    calls = [];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    });
    return readerApiPlaygroundSnapshots(createDataApi(fetchFn));
  }

  it("is available when the reader answers for the signed-in session", async () => {
    expect(await store().available("course.test")).toBe(true);
    expect(calls[0].url).toBe("/api/playground?courseId=course.test");
  });

  it("is not available signed out, or on a server without a database", async () => {
    expect(await store(401).available("course.test")).toBe(false);
    expect(await store(503).available("course.test")).toBe(false);
  });

  it("reviews only when the server says the session teaches the course", async () => {
    expect(await store(200, { reviews: true, snapshots: [] }).reviews("course.test")).toBe(true);
    expect(await store().reviews("course.test")).toBe(false);
    expect(await store(401).reviews("course.test")).toBe(false);
  });

  it("hands in the workspace without naming the student: the server takes them from the session", async () => {
    expect(await store(204).save(snapshot)).toBe(true);
    expect(calls[0].init?.method).toBe("PUT");
    const sent = JSON.parse(String(calls[0].init?.body));
    expect(sent).not.toHaveProperty("studentId");
    expect(sent).not.toHaveProperty("studentName");
    expect(sent).toMatchObject({ courseId: "course.test", runtime: "python", lastOutput: "1\n" });
  });

  it("says it did not save when the reader refuses", async () => {
    expect(await store(401).save(snapshot)).toBe(false);
  });

  it("asks for one student's snapshot by their id and reads the first back", async () => {
    const stored = { ...snapshot, updatedAt: row.updated_at };
    expect(await store(200, { reviews: true, snapshots: [stored] }).get("course.test", "lo", "ada")).toEqual(stored);
    expect(calls[0].url).toBe("/api/playground?courseId=course.test&loId=lo&studentId=ada");
    expect(await store(403).get("course.test", "lo", "bob")).toBeNull();
  });

  it("lists what the server lets the session see, and nothing when it refuses", async () => {
    expect(await store(200, { reviews: false, snapshots: [{ ...snapshot, updatedAt: row.updated_at }] }).list("course.test", "lo")).toHaveLength(1);
    expect(await store(503).list("course.test", "lo")).toEqual([]);
  });

  it("withdraws the session's own hand-in", async () => {
    await store(204).remove("course.test", "lo", "ada");
    expect(calls[0].init?.method).toBe("DELETE");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ courseId: "course.test", loId: "lo" });
  });
});

describe("the server's snapshot rows", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await testDatabase();
  }, 60_000);
  afterAll(() => db.close());
  beforeEach(() => db.reset());
  const rows = (sql: SqlClient = db.sql) => postgresPlaygroundSnapshotRows(sql);
  const stored = async () => (await db.sql.query<Record<string, unknown>>("SELECT * FROM playground_snapshots")).rows;
  const insert = (r: Record<string, unknown>) =>
    db.sql.query(
      `INSERT INTO playground_snapshots (student_id, student_name, course_id, lo_id, runtime, entry, files, last_output, last_ok, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)`,
      [r.student_id, r.student_name, r.course_id, r.lo_id, r.runtime, r.entry, JSON.stringify(r.files), r.last_output, r.last_ok, r.updated_at]
    );

  it("keeps the whole workspace and what it printed", async () => {
    await rows().save(snapshot);
    const [row] = await stored();
    expect(row).toMatchObject({ student_id: "ada", student_name: "Ada Lovelace", course_id: "course.test", runtime: "python", entry: "main.py", last_output: "1\n", last_ok: true });
    expect(row.files).toEqual([{ path: "main.py", content: "print(1)" }]);
  });

  it("truncates a runaway loop's output rather than storing megabytes of it", async () => {
    await rows().save({ ...snapshot, lastOutput: "x".repeat(50_000) });
    const [row] = await stored();
    expect((row.last_output as string).length).toBe(20_000);
  });

  it("reads one exercise's rows back as snapshots, leaving nothing undefined", async () => {
    // The schema keeps `files` (default []) but lets a row lack a name, output and result.
    await insert({ ...row, student_name: null, files: [], last_output: null, last_ok: null });
    expect(await rows().list("course.test", row.lo_id, null)).toEqual([
      { studentId: "ada", studentName: "ada", courseId: "course.test", loId: row.lo_id, runtime: "python", entry: "main.py", files: [], lastOutput: "", lastOk: null, updatedAt: row.updated_at }
    ]);
  });

  it("reads only one student's row when asked for them, newest first, with the last hand-in winning", async () => {
    await rows().save(snapshot);
    await new Promise((done) => setTimeout(done, 2));
    await rows().save({ ...snapshot, studentId: "bob", studentName: "Bob" });
    await new Promise((done) => setTimeout(done, 2));
    await rows().save({ ...snapshot, lastOutput: "2" });
    expect((await rows().list("course.test", row.lo_id, null)).map((s) => [s.studentId, s.lastOutput])).toEqual([
      ["ada", "2"],
      ["bob", "1\n"]
    ]);
    expect((await rows().list("course.test", row.lo_id, "bob")).map((s) => s.studentId)).toEqual(["bob"]);
    expect(await rows().list("course.test", "other", null)).toEqual([]);
  });

  it("removes one student's row", async () => {
    await rows().save(snapshot);
    await rows().save({ ...snapshot, studentId: "bob", studentName: "Bob" });
    await rows().remove("course.test", row.lo_id, "ada");
    expect((await rows().list("course.test", row.lo_id, null)).map((s) => s.studentId)).toEqual(["bob"]);
  });

  it("fails loudly when the database refuses, so the route answers 500", async () => {
    const refusing: SqlClient = { query: async () => Promise.reject(new Error("permission denied")), end: async () => {} };
    await expect(rows(refusing).list("course.test", "lo", null)).rejects.toThrow("playground_snapshots select: permission denied");
    await expect(rows(refusing).save(snapshot)).rejects.toThrow("playground_snapshots upsert");
    await expect(rows(refusing).remove("course.test", "lo", "ada")).rejects.toThrow("playground_snapshots delete: permission denied");
  });
});
