/**
 * The PlaygroundSnapshots adapter over Supabase: the only part of a playground that leaves the browser.
 *
 * Everything here turns on one thing: the reader's token. Without it there is no client, and
 * without a client every call has to answer "nothing" rather than fail, because most deployments
 * will never configure this at all.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { supabasePlaygroundSnapshots, RUNTIME_TOKEN_ROUTE } from "@tutors/store-supabase";
import { MockSupabaseClient } from "../../bdd/support/mocks";

vi.mock("@tutors/logger", () => ({ default: { error: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

/** A token shaped like the one /api/runtime-token signs, minus a signature nobody here checks. */
function token(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(claims)}.signature`;
}

const studentToken = { ok: true, body: { token: token({ sub: "ada" }), expiresIn: 3600 } };

let client: MockSupabaseClient;
let fetchFn: ReturnType<typeof vi.fn>;
let clientFor: ReturnType<typeof vi.fn>;

/** The adapter against a reader that answers the token request like this. */
function store(response: { ok: boolean; body?: unknown } | Error = studentToken) {
  fetchFn = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return { ok: response.ok, json: async () => response.body } as unknown as Response;
  });
  clientFor = vi.fn(() => client);
  return supabasePlaygroundSnapshots({ url: "https://mock.supabase.co", key: "mock-anon-key", fetchFn: fetchFn as unknown as typeof fetch, clientFor: clientFor as never });
}

beforeEach(() => {
  client = new MockSupabaseClient();
  client.setTableData("playground_snapshots", []);
});

describe("available", () => {
  it("acts as the student with the token the reader minted", async () => {
    expect(await store().available("course.test")).toBe(true);
    expect(clientFor).toHaveBeenCalledWith(token({ sub: "ada" }));
  });

  it("asks the reader for a token for the course being opened", async () => {
    await store().available("some.course/with spaces");
    expect(fetchFn).toHaveBeenCalledWith(`${RUNTIME_TOKEN_ROUTE}?courseId=some.course%2Fwith%20spaces`);
  });

  it("reuses a token rather than minting one per keystroke", async () => {
    const snapshots = store();
    await snapshots.available("course.test");
    await snapshots.available("course.test");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("mints a new token when the student moves to another course", async () => {
    const snapshots = store();
    await snapshots.available("course.one");
    await snapshots.available("course.two");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("is nothing at all on a deployment with no JWT secret", async () => {
    expect(await store({ ok: false }).available("course.test")).toBe(false);
  });

  it("is nothing at all when the reader cannot be reached", async () => {
    expect(await store(new Error("offline")).available("course.test")).toBe(false);
  });

  it("is nothing at all when Supabase is not configured", async () => {
    const snapshots = supabasePlaygroundSnapshots({ url: undefined, key: undefined, fetchFn: vi.fn() as unknown as typeof fetch });
    expect(await snapshots.available("course.test")).toBe(false);
  });
});

describe("reviews", () => {
  it("believes the reader's claim rather than anything the page says", async () => {
    const educator = store({ ok: true, body: { token: token({ sub: "ada", educator_courses: ["course.test"] }), expiresIn: 3600 } });
    expect(await educator.reviews("course.test")).toBe(true);
  });

  it("is false for a course the token does not name", async () => {
    const other = store({ ok: true, body: { token: token({ sub: "ada", educator_courses: ["other.course"] }), expiresIn: 3600 } });
    expect(await other.reviews("course.test")).toBe(false);
  });

  it("is false for a student, whose token carries no such claim", async () => {
    expect(await store().reviews("course.test")).toBe(false);
  });

  it("is false when there is no token to read", async () => {
    expect(await store({ ok: false }).reviews("course.test")).toBe(false);
  });
});

describe("save", () => {
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

  it("hands in the whole workspace and what it printed", async () => {
    expect(await store().save(snapshot)).toBe(true);
    const [row] = client.getTableData("playground_snapshots") as Array<Record<string, unknown>>;
    expect(row).toMatchObject({
      student_id: "ada",
      student_name: "Ada Lovelace",
      course_id: "course.test",
      lo_id: "/playground/course.test/topic/hello",
      runtime: "python",
      entry: "main.py",
      last_output: "1\n",
      last_ok: true
    });
    expect(row.files).toEqual([{ path: "main.py", content: "print(1)" }]);
  });

  it("truncates a runaway loop's output rather than posting megabytes of it", async () => {
    await store().save({ ...snapshot, lastOutput: "x".repeat(50_000) });
    const [row] = client.getTableData("playground_snapshots") as Array<Record<string, unknown>>;
    expect((row.last_output as string).length).toBe(20_000);
  });

  it("says it did not save when there is nowhere to save to", async () => {
    expect(await store({ ok: false }).save(snapshot)).toBe(false);
  });

  it("says it did not save when the database refuses the row", async () => {
    client.setTableError("playground_snapshots", { message: "new row violates row-level security policy" });
    expect(await store().save(snapshot)).toBe(false);
  });
});

describe("list", () => {
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

  it("reads back what was handed in for one exercise", async () => {
    client.setTableData("playground_snapshots", [row]);
    const [snapshot] = await store().list("course.test", "/playground/course.test/topic/hello");
    expect(snapshot).toEqual({
      studentId: "ada",
      studentName: "Ada Lovelace",
      courseId: "course.test",
      loId: "/playground/course.test/topic/hello",
      runtime: "python",
      entry: "main.py",
      files: [{ path: "main.py", content: "print(1)" }],
      lastOutput: "1\n",
      lastOk: true,
      updatedAt: "2026-09-10T09:00:00.000Z"
    });
  });

  it("leaves nothing undefined for a row with no name, output or verdict", async () => {
    client.setTableData("playground_snapshots", [{ ...row, student_name: null, files: null, last_output: null, last_ok: null }]);
    const [snapshot] = await store().list("course.test", "/playground/course.test/topic/hello");
    expect(snapshot).toMatchObject({ studentName: "ada", files: [], lastOutput: "", lastOk: null });
  });

  it("is empty for a reader that cannot mint a token", async () => {
    expect(await store({ ok: false }).list("course.test", "lo")).toEqual([]);
  });

  it("is empty rather than broken when the query is refused", async () => {
    client.setTableError("playground_snapshots", { message: "permission denied" });
    expect(await store().list("course.test", "lo")).toEqual([]);
  });
});

describe("get", () => {
  it("is null for a student who has handed in nothing", async () => {
    expect(await store().get("course.test", "lo", "ada")).toBeNull();
  });

  it("is null when there is no token", async () => {
    expect(await store({ ok: false }).get("course.test", "lo", "ada")).toBeNull();
  });
});
