import { describe, it, expect, vi, beforeEach } from "vitest";
import { courseEducators, courseLocationOf, isCourseEducator } from "../../../packages/application/src/index.ts";
import { InMemoryCourseSource } from "../../../packages/application/src/testing/index.ts";
import { httpCourseSource } from "../../../packages/adapters/driven/course-http/src/index.ts";

/**
 * Authorisation gate for the educator snippet dashboard and the lecturer
 * broadcast route (issue #155, #78).
 *
 * This is the only thing standing in front of the service-role key, which
 * bypasses RLS entirely: `course_gists` has no policies, so if this check
 * says yes the caller reads every active snippet in the course. The tests that
 * matter most here are the negative ones.
 */

const COURSE = "cs101-2025";
const withEducators = (...educators: string[]) => ({ enrollment: { educators } });

/** The gate over a published course, with a fetch stub the way the apps' servers pass one. */
function gate(opts: { json?: unknown; ok?: boolean; status?: number; throws?: boolean; nowMs?: () => number }) {
  const fetchMock = vi.fn(async () => {
    if (opts.throws) throw new Error("network down");
    return { ok: opts.ok ?? true, status: opts.status ?? 200, text: async () => JSON.stringify(opts.json ?? {}) };
  });
  const check = isCourseEducator(courseEducators({ source: httpCourseSource(), nowMs: opts.nowMs }));
  return { check: (courseId: string, login: string | null) => check(courseId, login, fetchMock), fetchMock };
}

beforeEach(() => vi.restoreAllMocks());

describe("isCourseEducator", () => {
  it("authorises a login listed in the course enrollment", async () => {
    const { check } = gate({ json: withEducators("lgriffin", "someone") });
    expect(await check(COURSE, "lgriffin")).toEqual({ ok: true, login: "lgriffin" });
  });

  it("rejects an anonymous caller without even reading the course", async () => {
    const { check, fetchMock } = gate({ json: withEducators("lgriffin") });
    expect(await check(COURSE, null)).toEqual({ ok: false, reason: "anonymous" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a signed-in student who is not an educator", async () => {
    const { check } = gate({ json: withEducators("lgriffin") });
    expect(await check(COURSE, "student1")).toEqual({ ok: false, reason: "not-educator" });
  });

  it("is case-sensitive on the login (no accidental widening)", async () => {
    const { check } = gate({ json: withEducators("lgriffin") });
    expect((await check(COURSE, "LGriffin")).ok).toBe(false);
  });

  describe("fails closed", () => {
    it("denies when the course has no enrollment block", async () => {
      const { check } = gate({ json: { title: "A course" } });
      expect(await check(COURSE, "lgriffin")).toEqual({ ok: false, reason: "no-enrollment" });
    });

    it("denies when the educators list is empty", async () => {
      const { check } = gate({ json: withEducators() });
      expect(await check(COURSE, "lgriffin")).toEqual({ ok: false, reason: "no-enrollment" });
    });

    it("denies when tutors.json 404s", async () => {
      const { check } = gate({ ok: false, status: 404 });
      expect(await check(COURSE, "lgriffin")).toEqual({ ok: false, reason: "no-enrollment" });
    });

    it("denies when the fetch throws", async () => {
      const { check } = gate({ throws: true });
      expect(await check(COURSE, "lgriffin")).toEqual({ ok: false, reason: "no-enrollment" });
    });

    it("denies when tutors.json is malformed", async () => {
      const { check } = gate({ json: { enrollment: "not-an-object" } });
      expect((await check(COURSE, "lgriffin")).ok).toBe(false);
    });

    it("denies when the course is not published at all", async () => {
      const check = isCourseEducator(courseEducators({ source: new InMemoryCourseSource() }));
      expect(await check("missing", "lgriffin")).toEqual({ ok: false, reason: "no-enrollment" });
    });
  });

  describe("course id resolution", () => {
    it("resolves a bare course id to its netlify origin", async () => {
      const { check, fetchMock } = gate({ json: withEducators("lgriffin") });
      await check("cs101-2025", "lgriffin");
      expect(fetchMock).toHaveBeenCalledWith("https://cs101-2025.netlify.app/tutors.json");
    });

    it("resolves a bare domain over https", async () => {
      const { check, fetchMock } = gate({ json: withEducators("lgriffin") });
      await check("course.example.com", "lgriffin");
      expect(fetchMock).toHaveBeenCalledWith("https://course.example.com/tutors.json");
    });

    it("resolves localhost over http", async () => {
      const { check, fetchMock } = gate({ json: withEducators("lgriffin") });
      await check("localhost:5173", "lgriffin");
      expect(fetchMock).toHaveBeenCalledWith("http://localhost:5173/tutors.json");
    });

    it("hands the CourseSource the protocol apart from the host", () => {
      expect(courseLocationOf("localhost:5173")).toEqual({ courseId: "localhost:5173", courseUrl: "localhost:5173", protocol: "http://" });
      expect(courseLocationOf("cs101-2025")).toEqual({ courseId: "cs101-2025", courseUrl: "cs101-2025.netlify.app", protocol: "https://" });
    });
  });

  describe("caching", () => {
    it("reads tutors.json once for repeated checks on the same course", async () => {
      const { check, fetchMock } = gate({ json: withEducators("lgriffin") });
      await check(COURSE, "lgriffin");
      await check(COURSE, "lgriffin");
      await check(COURSE, "lgriffin");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("caches a denial too, so a broken fetch is not retried per request", async () => {
      const { check, fetchMock } = gate({ throws: true });
      await check(COURSE, "lgriffin");
      await check(COURSE, "lgriffin");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("reads again once the cache has aged", async () => {
      let now = 0;
      const { check, fetchMock } = gate({ json: withEducators("lgriffin"), nowMs: () => now });
      await check(COURSE, "lgriffin");
      now = 5 * 60 * 1000 + 1;
      await check(COURSE, "lgriffin");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("keeps courses separate", async () => {
      const source = new InMemoryCourseSource({ "course-a": withEducators("lgriffin"), "course-b": withEducators("someone-else") });
      const check = isCourseEducator(courseEducators({ source }));
      expect((await check("course-a", "lgriffin")).ok).toBe(true);
      expect((await check("course-b", "lgriffin")).ok).toBe(false);
    });

    it("does not cache the authorisation decision, only the educator list", async () => {
      const { check, fetchMock } = gate({ json: withEducators("lgriffin") });
      expect((await check(COURSE, "lgriffin")).ok).toBe(true);
      // Same course, different user, list served from cache: must be re-evaluated.
      expect(await check(COURSE, "student1")).toEqual({ ok: false, reason: "not-educator" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
