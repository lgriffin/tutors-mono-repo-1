/**
 * The store-supabase adapter's reads and writes over a scripted client, the server's service client
 * in production: each function passes the right table and filters, and turns a failed query into an
 * empty answer (or null where the caller must tell a failure from an empty course). Without a client
 * the ports degrade to "nothing" and the health check is skipped.
 */
import { describe, expect, it, vi } from "vitest";
import {
  checkSupabase,
  getLocksForCourse,
  getRecentErrorCounts,
  readRoster,
  removeLock,
  supabaseAccessStore,
  supabaseLearningRecords,
  upsertLatest,
  upsertLock
} from "@tutors/store-supabase";

import { scriptedSupabase } from "../../support/scripted-supabase.ts";

vi.mock("@tutors/logger", () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

const scriptedClient = scriptedSupabase;

describe("without a client", () => {
  it("every read is empty and the health check is skipped", async () => {
    const records = supabaseLearningRecords();
    expect(await records.calendarEntries("cs101")).toEqual([]);
    expect(await records.learningRecords("cs101")).toEqual([]);
    expect(await records.learners("cs101")).toEqual([]);
    expect(await checkSupabase(undefined)).toEqual({ status: "skipped", latencyMs: 0, message: "no database client on this server" });
    expect(await getRecentErrorCounts(undefined)).toEqual([]);
  });
});

describe("learning records", () => {
  it("filters the calendar by course and inclusive day range", async () => {
    const { client, calls } = scriptedClient({ calendar: [{ data: [{ id: "2026-01-05" }] }] });
    expect(await supabaseLearningRecords(client as never).calendarEntries("cs101", "2026-01-01", "2026-01-31")).toEqual([{ id: "2026-01-05" }]);
    expect(calls.map((c) => [c.op, ...c.args])).toEqual([
      ["select", "*"],
      ["eq", "courseid", "cs101"],
      ["gte", "id", "2026-01-01"],
      ["lte", "id", "2026-01-31"]
    ]);
  });

  it("reads one learner's records when asked, and nothing for no course or a failed query", async () => {
    const { client, calls } = scriptedClient({ learning_records: [{ data: [{ student_id: "bob" }] }, { data: null, error: { message: "down" } }] });
    const records = supabaseLearningRecords(client as never);
    expect(await records.learningRecords("cs101", "bob")).toEqual([{ student_id: "bob" }]);
    expect(calls.map((c) => c.op)).toEqual(["select", "eq", "eq"]);
    expect(await records.learningRecords("cs101")).toEqual([]);
    expect(await records.learningRecords("")).toEqual([]);
    expect(await records.calendarEntries("")).toEqual([]);
  });

  it("lists the learners with records in the course, once each, and nobody for an empty course", async () => {
    const { client, calls } = scriptedClient({
      learning_records: [{ data: [{ student_id: "ann" }, { student_id: "ann" }, { student_id: "bob" }] }, { data: [] }],
      "tutors-connect-users": [{ data: [{ github_id: "ann" }, { github_id: "bob" }] }]
    });
    const records = supabaseLearningRecords(client as never);
    expect(await records.learners("cs101")).toEqual([{ github_id: "ann" }, { github_id: "bob" }]);
    expect(calls.find((c) => c.op === "in")?.args).toEqual(["github_id", ["ann", "bob"]]);
    expect(await records.learners("cs101")).toEqual([]);
  });

  it("answers nobody when the users read fails", async () => {
    const { client } = scriptedClient({
      learning_records: [{ data: [{ student_id: "ann" }] }],
      "tutors-connect-users": [{ data: null, error: { message: "down" } }]
    });
    expect(await supabaseLearningRecords(client as never).learners("cs101")).toEqual([]);
  });
});

describe("content locks", () => {
  it("reads a course's locks and gives none for a failed read", async () => {
    const { client, ops } = scriptedClient({ tutors_content_locks: [{ data: [{ lo_route: "/lab/1", locked: true }] }, { data: null, error: { message: "down" } }] });
    const db = client as never;
    expect(await getLocksForCourse("cs101", db)).toEqual([{ lo_route: "/lab/1", locked: true }]);
    expect(ops("tutors_content_locks")).toEqual(["select", "eq"]);
    expect(await getLocksForCourse("cs101", db)).toEqual([]);
    expect(await getLocksForCourse("", db)).toEqual([]);
  });

  it("upserts a lock keyed by course and route, and reports a failed write", async () => {
    const { client, calls } = scriptedClient({ tutors_content_locks: [{ error: null }, { error: { message: "down" } }] });
    const db = client as never;
    expect(await upsertLock("cs101", "/lab/1", true, "lecturer", db)).toBe(true);
    const upsert = calls.find((c) => c.op === "upsert")!;
    expect(upsert.args[0]).toMatchObject({ course_id: "cs101", lo_route: "/lab/1", locked: true, locked_by: "lecturer" });
    expect(upsert.args[1]).toEqual({ onConflict: "course_id,lo_route" });
    expect(await upsertLock("cs101", "/lab/1", true, "lecturer", db)).toBe(false);
    expect(await upsertLock("cs101", "/lab/1", true, "", db)).toBe(false);
  });

  it("removes a lock by course and route, and reports a delete that matched nothing or failed", async () => {
    const { client, ops } = scriptedClient({ tutors_content_locks: [{ data: [{ lo_route: "/lab/1" }], error: null }, { data: [], error: null }, { error: { message: "down" } }] });
    const db = client as never;
    expect(await removeLock("cs101", "/lab/1", db)).toBe(true);
    expect(ops("tutors_content_locks")).toEqual(["delete", "eq", "eq", "select"]);
    expect(await removeLock("cs101", "/lab/1", db)).toBe(false);
    expect(await removeLock("cs101", "/lab/1", db)).toBe(false);
    expect(await removeLock("cs101", "", db)).toBe(false);
  });

  it("is the AccessStore the application composes", async () => {
    const { client } = scriptedClient({ tutors_content_locks: [{ data: [] }] });
    const store = supabaseAccessStore(client as never);
    expect(await store.locks("cs101")).toEqual([]);
  });
});

describe("latest presence rows", () => {
  it("upserts the latest snapshot per course and student, and fails loudly when the write does", async () => {
    const { client, calls } = scriptedClient({ "tutors-connect-latest": [{ error: null }, { error: { message: "down" } }] });
    await upsertLatest(client as never, "ann", "cs101", { courseId: "cs101" });
    const upsert = calls.find((c) => c.op === "upsert")!;
    expect(upsert.args[0]).toMatchObject({ course_id: "cs101", student_id: "ann" });
    expect(upsert.args[1]).toEqual({ onConflict: "course_id,student_id" });
    await expect(upsertLatest(client as never, "bob", "cs101", {})).rejects.toThrow("tutors-connect-latest upsert: down");
  });

  it("reads a course's roster newest first, and tells a failed read (null) from an empty course", async () => {
    const { client, calls } = scriptedClient({ "tutors-connect-latest": [{ data: [{ student_id: "ann" }] }, { data: null, error: { message: "down" } }] });
    expect(await readRoster(client as never, "cs101", null)).toEqual([{ student_id: "ann" }]);
    expect(calls.find((c) => c.op === "order")?.args).toEqual(["received_at", { ascending: false }]);
    expect(calls.find((c) => c.op === "eq")?.args).toEqual(["course_id", "cs101"]);
    expect(calls.some((c) => c.op === "gte")).toBe(false);
    expect(await readRoster(client as never, "cs101", null)).toBeNull();
  });

  it("reads the rows since an instant, and the most recent 200 across every course without one", async () => {
    const { client, calls } = scriptedClient({ "tutors-connect-latest": [{ data: [] }] });
    expect(await readRoster(client as never, null, "2026-01-05T09:00:00.000Z")).toEqual([]);
    expect(calls.find((c) => c.op === "gte")?.args).toEqual(["received_at", "2026-01-05T09:00:00.000Z"]);
    expect(calls.find((c) => c.op === "limit")?.args).toEqual([200]);
  });
});

describe("health", () => {
  it("reports ok with a latency, an error with its message, and a thrown failure", async () => {
    const { client } = scriptedClient({ "tutors-connect-courses": [{ error: null, count: 3 }, { error: { message: "down" } }] });
    expect(await checkSupabase(client as never)).toMatchObject({ status: "ok" });
    expect(await checkSupabase(client as never)).toMatchObject({ status: "error", message: "down" });
    expect(await checkSupabase({ from: () => { throw new Error("boom"); } } as never)).toMatchObject({ status: "error", message: "boom" });
  });

  it("reads the last hour's error counts, and none when the call fails or throws", async () => {
    const { client, calls } = scriptedClient({ "rpc:get_error_counts": [{ data: [{ app: "reader", level: "error", count: 2 }] }, { data: null, error: { message: "down" } }] });
    expect(await getRecentErrorCounts(client as never)).toEqual([{ app: "reader", level: "error", count: 2 }]);
    expect(calls[0].args).toEqual([{ minutes_ago: 60 }]);
    expect(await getRecentErrorCounts(client as never)).toEqual([]);
    expect(await getRecentErrorCounts({ rpc: () => { throw new Error("boom"); } } as never)).toEqual([]);
  });
});
