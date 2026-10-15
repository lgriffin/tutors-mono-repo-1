/**
 * The store-supabase adapters behind the application's ports, run through each port's contract
 * suite over an in-memory PostgREST, so the Supabase adapters and the in-memory ones cannot drift.
 * Beside the contracts: what each adapter does on its own when the database refuses a query.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  accessStoreContract,
  playgroundSnapshotsContract,
  scormRecordsContract,
  snippetStoreContract,
  type ContractCase
} from "@tutors/application/testing";
import {
  configureSupabase,
  getScormRecord,
  StoreError,
  supabaseAccessStore,
  supabasePlaygroundSnapshots,
  supabaseScormRecords,
  supabaseSnippetStore,
  upsertScormRecord,
  readTimeRows
} from "@tutors/store-supabase";
import log from "@tutors/logger";
import { fakePostgrest } from "../../support/fake-postgrest.ts";

vi.mock("@tutors/logger", () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

/** `diverges` names cases the adapter is known to fail today: they run as `it.fails`, so fixing the adapter turns them red here until they are moved back. */
function contract(name: string, cases: ContractCase[], diverges: Record<string, string> = {}) {
  describe(name, () => {
    for (const c of cases) (c.name in diverges ? it.fails : it)(c.name, c.run);
  });
}

afterEach(() => configureSupabase(undefined));

/** A token shaped like the one /api/runtime-token signs; nothing here checks the signature. */
function token(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256" })}.${encode(claims)}.signature`;
}

/** The snapshots adapter as a signed-in student, over `db`. */
function snapshotsOver(db: ReturnType<typeof fakePostgrest>) {
  const fetchFn = vi.fn(async () => ({ ok: true, json: async () => ({ token: token({ sub: "ada" }), expiresIn: 3600 }) }) as unknown as Response);
  return supabasePlaygroundSnapshots({ url: "https://project.supabase.co", key: "anon", fetchFn, clientFor: () => db.client as never });
}

contract(
  "SnippetStore: Supabase",
  snippetStoreContract(() => supabaseSnippetStore(fakePostgrest().client as never), new Date().toISOString())
);
contract(
  "ScormRecords: Supabase",
  scormRecordsContract(() => {
    configureSupabase(fakePostgrest().client as never);
    return supabaseScormRecords();
  })
);
contract(
  "PlaygroundSnapshots: Supabase",
  playgroundSnapshotsContract(() => snapshotsOver(fakePostgrest()))
);
contract(
  "AccessStore: Supabase with the server's client",
  accessStoreContract(() => supabaseAccessStore(fakePostgrest().client as never))
);

describe("supabaseSnippetStore", () => {
  const later = new Date(Date.now() + 86_400_000).toISOString();
  const snippet = (learnerId: string) => ({ courseId: "cs101", learnerId, learnerName: null, filename: null as unknown as string, content: "boom", title: null, loRoute: null, loTitle: null, expiresAt: later });

  it("shows each sharer's avatar, a default file name, and newest first", async () => {
    const db = fakePostgrest({ "tutors-connect-users": [{ github_id: "ann", avatar_url: "https://avatars/ann.png" }, { avatar_url: "orphan" }] });
    const store = supabaseSnippetStore(db.client as never);
    await store.add(snippet("ann"));
    await new Promise((done) => setTimeout(done, 2));
    await store.add(snippet("bob"));

    const rows = await store.active("cs101", new Date().toISOString());

    expect(rows.map((row) => [row.learnerId, row.avatarUrl, row.filename])).toEqual([
      ["bob", null, "snippet.txt"],
      ["ann", "https://avatars/ann.png", "snippet.txt"]
    ]);
  });

  it("still lists the snippets when the avatars cannot be read", async () => {
    const db = fakePostgrest();
    const store = supabaseSnippetStore(db.client as never);
    await store.add(snippet("ann"));
    db.failNext("tutors-connect-users", "permission denied");

    expect((await store.active("cs101", new Date().toISOString())).map((row) => row.avatarUrl)).toEqual([null]);
    expect(log.warn).toHaveBeenCalledWith("Reading snippet avatars failed:", { message: "permission denied" });
  });

  it("lists nothing, and reads nothing, for no course", async () => {
    const db = fakePostgrest();
    expect(await supabaseSnippetStore(db.client as never).active("", new Date().toISOString())).toEqual([]);
    expect(db.queries).toEqual([]);
  });

  it("fails loudly when the insert or the listing is refused, and answers unknown for a refused count", async () => {
    const db = fakePostgrest();
    const store = supabaseSnippetStore(db.client as never);

    db.failNext("course_gists", "insert refused");
    await expect(store.add(snippet("ann"))).rejects.toThrow("insert refused");
    db.failNext("course_gists", "select refused");
    await expect(store.active("cs101", new Date().toISOString())).rejects.toThrow("select refused");
    db.failNext("course_gists", "count refused");
    expect(await store.countSince("cs101", "ann", "2000-01-01T00:00:00.000Z")).toBeNull();
  });

  it("fails when the insert hands back no row", async () => {
    const client = { from: () => ({ insert: () => ({ select: () => ({ single: async () => ({ data: null, error: null }) }) }) }) };
    await expect(supabaseSnippetStore(client as never).add(snippet("ann"))).rejects.toThrow("insert returned no row");
  });
});

describe("SCORM records", () => {
  const record = { courseId: "cs101", learnerId: "ada", loId: "/scorm/cs101/quiz", version: "2004" as const, cmi: { "cmi.location": "p3" }, summary: { completionStatus: "completed", successStatus: "passed", totalTime: 90, location: "p3", scoreRaw: 8, scoreMax: 10, scoreScaled: 0.8 } };

  it("keeps the summary columns Tutors reports on beside the whole data model", async () => {
    const db = fakePostgrest();
    configureSupabase(db.client as never);

    await upsertScormRecord(record);

    expect(db.rows("scorm_records")[0]).toMatchObject({
      course_id: "cs101",
      student_id: "ada",
      lo_id: "/scorm/cs101/quiz",
      scorm_version: "2004",
      completion_status: "completed",
      success_status: "passed",
      score_raw: 8,
      score_max: 10,
      score_scaled: 0.8,
      total_time: 90
    });
  });

  it("starts from nothing, rather than failing, without Supabase or when the database refuses", async () => {
    expect(await getScormRecord("cs101", "ada", "/scorm/cs101/quiz")).toEqual({});
    await upsertScormRecord(record);

    const db = fakePostgrest();
    configureSupabase(db.client as never);
    db.failNext("scorm_records", "down", 2);
    await upsertScormRecord(record);
    expect(await getScormRecord("cs101", "ada", "/scorm/cs101/quiz")).toEqual({});
    expect(log.error).toHaveBeenCalledWith("upsertScormRecord failed:", { message: "down" });
    expect(log.error).toHaveBeenCalledWith("getScormRecord failed:", { message: "down" });
  });
});

describe("playground snapshots", () => {
  it("reads one student's snapshot back", async () => {
    const db = fakePostgrest({
      playground_snapshots: [{ student_id: "ada", student_name: null, course_id: "cs101", lo_id: "lo", runtime: "python", entry: "main.py", files: null, last_output: null, last_ok: false, updated_at: "2026-09-10T09:00:00.000Z" }]
    });
    expect(await snapshotsOver(db).get("cs101", "lo", "ada")).toEqual({
      studentId: "ada",
      studentName: "ada",
      courseId: "cs101",
      loId: "lo",
      runtime: "python",
      entry: "main.py",
      files: [],
      lastOutput: "",
      lastOk: false,
      updatedAt: "2026-09-10T09:00:00.000Z"
    });
  });

  it("answers null for a refused read and logs a refused removal", async () => {
    const db = fakePostgrest();
    const snapshots = snapshotsOver(db);
    db.failNext("playground_snapshots", "denied", 2);
    expect(await snapshots.get("cs101", "lo", "ada")).toBeNull();
    await snapshots.remove("cs101", "lo", "ada");
    expect(log.error).toHaveBeenCalledWith("removePlaygroundSnapshot failed:", { message: "denied" });
  });

  it("refuses a hand-in that names no student, and does nothing without a token", async () => {
    const db = fakePostgrest();
    expect(await snapshotsOver(db).save({ studentId: "", studentName: "", courseId: "cs101", loId: "lo", runtime: "python", entry: "main.py", files: [], lastOutput: "", lastOk: null })).toBe(false);

    const signedOut = supabasePlaygroundSnapshots({ url: "https://project.supabase.co", key: "anon", fetchFn: (async () => ({ ok: false })) as never });
    await signedOut.remove("cs101", "lo", "ada");
    expect(db.queries).toEqual([]);
  });

  it("is not a reviewer when the token's claims cannot be read", async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, json: async () => ({ token: "not-a-jwt", expiresIn: 3600 }) }) as unknown as Response);
    const snapshots = supabasePlaygroundSnapshots({ url: "https://project.supabase.co", key: "anon", fetchFn, clientFor: () => fakePostgrest().client as never });
    expect(await snapshots.reviews("cs101")).toBe(false);
  });
});

describe("readTimeRows", () => {
  const course = { course_id: "cs101", course_record: { title: "CS 101" } };

  it("reads a course's calendar, records, learners and assignments with their submission counts", async () => {
    const db = fakePostgrest({
      "tutors-connect-courses": [course],
      calendar: [
        { id: "2026-01-06", courseid: "cs101", studentid: "ann" },
        { id: "2026-01-05", courseid: "cs101", studentid: "bob" },
        { id: "2025-12-01", courseid: "cs101", studentid: "old" },
        { id: "2026-01-05", courseid: "cs999", studentid: "elsewhere" },
        { id: "2026-01-07", courseid: "cs101", studentid: "" }
      ],
      learning_records: [
        { course_id: "cs101", student_id: "ann", date_last_accessed: "2026-01-06" },
        { course_id: "cs101", student_id: "cat", date_last_accessed: "2026-01-07" },
        { course_id: "cs101", student_id: null, date_last_accessed: "2026-01-04" }
      ],
      "tutors-connect-users": [
        { github_id: "ann", full_name: "Ann" },
        { github_id: "bob", full_name: "Bob" },
        { github_id: "cat", full_name: "Cat" },
        { github_id: "zed", full_name: "Zed" }
      ],
      assignments: [
        { id: 1, name: "Lab 1", courseid: "cs101" },
        { id: 2, name: "Lab 2", courseid: "cs101" }
      ],
      assignments_submissions: [{ assignmentId: 1 }, { assignmentId: 1 }, { assignmentId: 3 }]
    });

    const rows = await readTimeRows(db.client as never, "cs101", "2026-01-01", "2026-01-31");

    expect(rows.courseId).toBe("cs101");
    expect(rows.role).toBe("educator");
    expect(rows.course).toEqual(course);
    expect(rows.calendar.map((r) => r.studentid)).toEqual(["bob", "ann", ""]);
    expect(rows.learningRecords.map((r) => r.student_id)).toEqual(["cat", "ann", null]);
    expect(rows.users.map((u) => u.github_id).sort()).toEqual(["ann", "bob", "cat"]);
    expect(rows.assignments.map((a) => [a.name, a.submissionCount])).toEqual([
      ["Lab 1", 2],
      ["Lab 2", 0]
    ]);
  });

  it("pages through more rows than one request returns, and asks for learners two hundred at a time", async () => {
    const calendar = Array.from({ length: 1001 }, (_, i) => ({ id: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`, courseid: "cs101", studentid: `s${i % 250}` }));
    const db = fakePostgrest({ calendar });

    const rows = await readTimeRows(db.client as never, "cs101");

    expect(rows.calendar).toHaveLength(1001);
    expect(rows.course).toBeNull();
    expect(rows.assignments).toEqual([]);
    expect(db.queries.filter((q) => q.table === "calendar")).toHaveLength(2);
    expect(db.queries.filter((q) => q.table === "tutors-connect-users")).toHaveLength(2);
  });

  it("fails with what it was reading when a query is refused", async () => {
    const refused = (table: string) => {
      const db = fakePostgrest();
      db.failNext(table, "permission denied");
      return readTimeRows(db.client as never, "cs101");
    };
    await expect(refused("calendar")).rejects.toThrow(new StoreError("calendar read", { message: "permission denied" }));
    await expect(refused("tutors-connect-courses")).rejects.toThrow("tutors-connect-courses read: permission denied");

    const db = fakePostgrest({ learning_records: [{ course_id: "cs101", student_id: "ann" }] });
    db.failNext("tutors-connect-users", "timeout");
    await expect(readTimeRows(db.client as never, "cs101")).rejects.toThrow("tutors-connect-users read: timeout");
  });

  it("leaves the assignments out when they cannot be read", async () => {
    const db = fakePostgrest({ assignments: [{ id: 1, name: "Lab 1", courseid: "cs101" }] });
    db.failNext("assignments", "no such table");
    expect((await readTimeRows(db.client as never, "cs101")).assignments).toEqual([]);
  });
});
