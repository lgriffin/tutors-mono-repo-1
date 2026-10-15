/**
 * The input checks and failure paths of the two "tell the class" use cases: a learner sharing a
 * snippet with the course's educators, and a lecturer broadcasting to everyone reading.
 * The happy paths live in the BDD suite and tests/unit/community/broadcast.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  broadcastToCourse,
  createBroadcastLimiter,
  parseBroadcastMessage,
  parseSnippetInput,
  shareSnippet,
  SNIPPET_TTL_MS
} from "@tutors/application";
import { FixedClock, InMemoryCourseNotices, InMemorySnippetStore } from "@tutors/application/testing";
import type { CourseNotices, SnippetStore } from "@tutors/application/ports";

const learner = { login: "ada", name: "Ada" };

describe("parseSnippetInput", () => {
  it("copies the known fields, trimmed, and nothing else", () => {
    expect(parseSnippetInput({ courseId: " cs101 ", filename: " main.py ", content: "  print(1)\n", title: " T ", loRoute: "/lab/1", loTitle: "Lab 1", extra: "dropped" })).toEqual({
      courseId: "cs101",
      filename: "main.py",
      content: "  print(1)\n",
      title: "T",
      loRoute: "/lab/1",
      loTitle: "Lab 1"
    });
  });

  it("treats a missing title, route and step title as empty", () => {
    expect(parseSnippetInput({ courseId: "cs101", filename: "a.js", content: "x" })).toEqual({ courseId: "cs101", filename: "a.js", content: "x", title: "", loRoute: "", loTitle: "" });
  });

  it.each([
    [null, "body is not an object"],
    ["text", "body is not an object"],
    [{ filename: "a", content: "x" }, "courseId is required, at most 200 characters"],
    [{ courseId: "c".repeat(201), filename: "a", content: "x" }, "courseId is required, at most 200 characters"],
    [{ courseId: 42, filename: "a", content: "x" }, "courseId is required, at most 200 characters"],
    [{ courseId: "cs101", filename: "   ", content: "x" }, "filename is required, at most 200 characters"],
    [{ courseId: "cs101", filename: "a", content: 7 }, "content is required"],
    [{ courseId: "cs101", filename: "a", content: "   " }, "content is required"],
    [{ courseId: "cs101", filename: "a", content: "x", title: 1 }, "title, loRoute and loTitle are strings of at most 500 characters"],
    [{ courseId: "cs101", filename: "a", content: "x", loRoute: "r".repeat(501) }, "title, loRoute and loTitle are strings of at most 500 characters"],
    [{ courseId: "cs101", filename: "a", content: "x", loTitle: false }, "title, loRoute and loTitle are strings of at most 500 characters"]
  ])("refuses %j with a reason", (body, reason) => {
    expect(parseSnippetInput(body)).toBe(reason);
  });
});

describe("shareSnippet failure paths", () => {
  const input = { courseId: "cs101", filename: "main.py", content: "print(1)" };

  it("reports a failed write and posts no notice", async () => {
    const notices = new InMemoryCourseNotices();
    const store: SnippetStore = { add: async () => Promise.reject(new Error("db down")), active: async () => [], countSince: async () => 0 };
    expect(await shareSnippet({ store, notices, clock: new FixedClock() })(input, learner)).toEqual({ ok: false, reason: "failed" });
    expect(notices.posted).toEqual([]);
  });

  it("keeps the share when the notice cannot be posted", async () => {
    const clock = new FixedClock();
    const store = new InMemorySnippetStore(clock);
    const notices: CourseNotices = { post: async () => Promise.reject(new Error("broker down")), watch: () => () => {} };
    const result = await shareSnippet({ store, notices, clock })(input, learner);
    expect(result).toEqual({ ok: true, id: "snippet-1", expiresAt: new Date(clock.nowMs() + SNIPPET_TTL_MS).toISOString() });
    expect(store.rows).toHaveLength(1);
  });

  it("does not rate-limit when the store cannot count, and names the notice with a fresh id by default", async () => {
    const clock = new FixedClock();
    const notices = new InMemoryCourseNotices();
    const rows: string[] = [];
    const store: SnippetStore = { add: async (s) => (rows.push(s.filename), `id-${rows.length}`), active: async () => [], countSince: async () => null };
    for (let i = 0; i < 5; i++) expect((await shareSnippet({ store, notices, clock })({ ...input, filename: "  " }, learner)).ok).toBe(true);
    expect(rows).toEqual(Array(5).fill("snippet.txt"));
    const ids = notices.posted.map((n) => n.id);
    expect(new Set(ids).size).toBe(5);
  });
});

describe("parseBroadcastMessage", () => {
  it("copies the message, trimmed, and drops an empty action", () => {
    expect(parseBroadcastMessage({ title: " Quiz open ", description: " Lab 2 ", actionUrl: " /lab-02 ", actionLabel: "Go", other: 1 })).toEqual({
      title: "Quiz open",
      description: "Lab 2",
      actionUrl: "/lab-02",
      actionLabel: "Go"
    });
    expect(parseBroadcastMessage({ title: "Hi", description: "There", actionUrl: "", actionLabel: "  " })).toEqual({ title: "Hi", description: "There", actionUrl: undefined, actionLabel: undefined });
    expect(parseBroadcastMessage({ title: "Hi", description: "There" })).toEqual({ title: "Hi", description: "There", actionUrl: undefined, actionLabel: undefined });
  });

  it.each([
    [undefined, "body is not an object"],
    [3, "body is not an object"],
    [{ description: "d" }, "title is required, at most 80 characters"],
    [{ title: "t".repeat(81), description: "d" }, "title is required, at most 80 characters"],
    [{ title: "t" }, "description is required, at most 280 characters"],
    [{ title: "t", description: "d".repeat(281) }, "description is required, at most 280 characters"],
    [{ title: "t", description: "d", actionUrl: 5 }, "actionUrl and actionLabel are strings"],
    [{ title: "t", description: "d", actionLabel: "l".repeat(25) }, "actionUrl and actionLabel are strings"]
  ])("refuses %j with a reason", (body, reason) => {
    expect(parseBroadcastMessage(body)).toBe(reason);
  });
});

describe("broadcastToCourse failure paths", () => {
  it("reports a post that throws as failed", async () => {
    const notices: CourseNotices = { post: async () => Promise.reject(new Error("broker down")), watch: () => () => {} };
    const send = broadcastToCourse({ notices, clock: new FixedClock(), limiter: createBroadcastLimiter() });
    expect(await send("cs101", { title: "t", description: "d" }, "Ann")).toEqual({ ok: false, reason: "failed" });
  });

  it("names a broadcast with a fresh id and falls back to Tutor for a blank sender", async () => {
    const notices = new InMemoryCourseNotices();
    const send = broadcastToCourse({ notices, clock: new FixedClock(), limiter: createBroadcastLimiter(0) });
    const first = await send("cs101", { title: "t", description: "d" }, "  ");
    const second = await send("cs101", { title: "t", description: "d" }, "Ann");
    expect(first.ok && first.broadcast.senderName).toBe("Tutor");
    expect(first.ok && first.broadcast.id).toMatch(/^bc-/);
    expect(first.ok && second.ok && first.broadcast.id !== second.broadcast.id).toBe(true);
  });
});
