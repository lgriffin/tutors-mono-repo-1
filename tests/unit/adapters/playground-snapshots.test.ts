/**
 * Playground snapshots, the only part of a playground that leaves the browser, on both sides of the
 * data API: the browser's adapter over /api/playground (which only asks: the server decides whose
 * rows the session may see, Rule 0475), and the server's rows over the service client.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createDataApi, readerApiPlaygroundSnapshots } from "@tutors/data-api";
import { supabasePlaygroundSnapshotRows } from "@tutors/store-supabase";
import { MockSupabaseClient } from "../../bdd/support/mocks";

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
  let client: MockSupabaseClient;
  beforeEach(() => {
    client = new MockSupabaseClient();
    client.setTableData("playground_snapshots", []);
  });
  const rows = () => supabasePlaygroundSnapshotRows(client as never);

  it("keeps the whole workspace and what it printed", async () => {
    await rows().save(snapshot);
    const [stored] = client.getTableData("playground_snapshots") as Array<Record<string, unknown>>;
    expect(stored).toMatchObject({ student_id: "ada", student_name: "Ada Lovelace", course_id: "course.test", runtime: "python", entry: "main.py", last_output: "1\n", last_ok: true });
    expect(stored.files).toEqual([{ path: "main.py", content: "print(1)" }]);
  });

  it("truncates a runaway loop's output rather than storing megabytes of it", async () => {
    await rows().save({ ...snapshot, lastOutput: "x".repeat(50_000) });
    const [stored] = client.getTableData("playground_snapshots") as Array<Record<string, unknown>>;
    expect((stored.last_output as string).length).toBe(20_000);
  });

  it("reads one exercise's rows back as snapshots, leaving nothing undefined", async () => {
    client.setTableData("playground_snapshots", [{ ...row, student_name: null, files: null, last_output: null, last_ok: null }]);
    expect(await rows().list("course.test", row.lo_id, null)).toEqual([
      { studentId: "ada", studentName: "ada", courseId: "course.test", loId: row.lo_id, runtime: "python", entry: "main.py", files: [], lastOutput: "", lastOk: null, updatedAt: row.updated_at }
    ]);
  });

  it("reads only one student's row when asked for them", async () => {
    client.setTableData("playground_snapshots", [row, { ...row, student_id: "bob" }]);
    expect((await rows().list("course.test", row.lo_id, "bob")).map((s) => s.studentId)).toEqual(["bob"]);
  });

  it("fails loudly when the database refuses, so the route answers 500", async () => {
    client.setTableError("playground_snapshots", { message: "permission denied" });
    await expect(rows().list("course.test", "lo", null)).rejects.toThrow("playground_snapshots select: permission denied");
    await expect(rows().save(snapshot)).rejects.toThrow("playground_snapshots upsert");
  });
});
