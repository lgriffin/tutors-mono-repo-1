import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../packages/adapters/driven/store-supabase/node_modules/@supabase/supabase-js/dist/index.mjs", async () => ({ createClient: (await import("../../bdd/support/supabase-recorder.ts")).createClient }));
vi.mock("@supabase/supabase-js", async () => ({ createClient: (await import("../../bdd/support/supabase-recorder.ts")).createClient }));
vi.mock("$app/env/public", () => ({ PUBLIC_SUPABASE_URL: "https://mock.supabase.co", PUBLIC_SUPABASE_ANON_KEY: "mock-anon-key", PUBLIC_ANON_MODE: "FALSE", PUBLIC_REALTIME: undefined }));
vi.mock("$app/env/private", async () => (await import("../../bdd/support/supabase-recorder.ts")).privateEnv);

import type { Course } from "@tutors/tutors-model-lib";
import { readerApiCourseVisit } from "../../../packages/adapters/driven/data-api/src/adapters.ts";
import { POST } from "../../../apps/reader/src/routes/api/courses/visit/+server.ts";
import { recorder } from "../../bdd/support/supabase-recorder.ts";

function createMockCourse(overrides: Partial<Course> = {}): Course {
  return {
    type: "course",
    courseId: overrides.courseId ?? "valid-course-1",
    title: overrides.title ?? "Test Course",
    img: overrides.img ?? "https://example.com/img.png",
    properties: { credits: "5", ...(overrides.properties ?? {}) },
    isPrivate: overrides.isPrivate ?? false,
    ...overrides
  } as Course;
}

const now = new Date("2026-10-15T10:00:00Z");
const reportVisit = readerApiCourseVisit();
const visitFromBrowser = (course: Course) => reportVisit(course, now);

let sent: { courseId: string; courseRecord: Record<string, unknown> }[];

const published = new Map<string, unknown>([
  ["valid-course-1", { title: "Published Title", properties: { credits: "Published Credits", private: 0 } }],
  ["private-course", { title: "Private Course", properties: { credits: "Staff", private: 1 } }]
]);

function courseHost(input: RequestInfo | URL): Response {
  const url = new URL(String(input));
  const id = url.hostname.replace(/\.netlify\.app$/, "");
  const json = published.get(id);
  return json ? new Response(JSON.stringify(json), { status: 200 }) : new Response("Not Found", { status: 404 });
}

async function visit(courseId: string, courseRecord: Record<string, unknown> = {}): Promise<Response> {
  const request = new Request("https://reader.test/api/courses/visit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ courseId, courseRecord })
  });
  return POST({ request, locals: { actor: null } } as unknown as Parameters<typeof POST>[0]).catch((e: { status?: number }) => {
    if (typeof e.status !== "number") throw e;
    return new Response(null, { status: e.status });
  });
}

beforeEach(() => {
  recorder.reset();
  sent = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/courses/visit") {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }
    return courseHost(input);
  });
});

describe("the course-visit report: the browser sends the visit to the reader's data API", () => {
  it("posts the course id and its card record", async () => {
    await visitFromBrowser(createMockCourse({ courseId: "record-course", title: "Record Course", properties: { credits: "10" } as never }));

    expect(sent).toEqual([{ courseId: "record-course", courseRecord: expect.objectContaining({ id: "record-course", title: "Record Course", credits: "10", private: false }) }]);
  });

  it("sends the image when the course has no icon, and the icon when it has one", async () => {
    await visitFromBrowser(createMockCourse({ img: "https://example.com/thumb.png" }));
    await visitFromBrowser(createMockCourse({ properties: { credits: "5", icon: { type: "mdi:school", color: "red" } } as never }));

    expect(sent[0].courseRecord).toMatchObject({ img: "https://example.com/thumb.png" });
    expect(sent[0].courseRecord.icon).toBeUndefined();
    expect(sent[1].courseRecord).toMatchObject({ icon: { type: "mdi:school", color: "red" } });
  });

  it("never writes a table from the browser", async () => {
    await visitFromBrowser(createMockCourse({ courseId: "record-course" }));

    expect(recorder.tableCalls).toEqual([]);
  });
});

describe("POST /api/courses/visit on the reader's server", () => {
  it("inserts a new course with visit_count 1, titled from the published course", async () => {
    const response = await visit("valid-course-1", { title: "A title the browser made up", credits: "made up" });

    expect(response.status).toBe(204);
    expect(recorder.rows("tutors-connect-courses")).toMatchObject([
      { course_id: "valid-course-1", visit_count: 1, course_record: { id: "valid-course-1", title: "Published Title", credits: "Published Credits", private: false } }
    ]);
  });

  it("increments visit_count when the course is already in the catalogue", async () => {
    recorder.seed("tutors-connect-courses", [{ course_id: "valid-course-1", visit_count: 5 }]);

    await visit("valid-course-1");

    expect(recorder.rows("tutors-connect-courses")).toMatchObject([{ course_id: "valid-course-1", visit_count: 6 }]);
  });

  it("marks a private course private whatever the browser says", async () => {
    await visit("private-course", { private: false });

    expect(recorder.rows("tutors-connect-courses")[0]).toMatchObject({ course_record: { private: true } });
  });

  it("keeps an https image or an icon from the browser, and drops anything else", async () => {
    await visit("valid-course-1", { img: "javascript:alert(1)" });
    expect(recorder.rows("tutors-connect-courses")[0].course_record).not.toHaveProperty("img");

    await visit("valid-course-1", { img: "https://example.com/thumb.png" });
    expect(recorder.rows("tutors-connect-courses")[0].course_record).toMatchObject({ img: "https://example.com/thumb.png" });
  });

  it("refuses a course its host does not publish, and writes nothing", async () => {
    const response = await visit("no-such-course");

    expect(response.status).toBe(404);
    expect(recorder.rows("tutors-connect-courses")).toEqual([]);
  });

  it("never fetches a host other than the course's Netlify site", async () => {
    const response = await visit("attacker.example");

    expect(response.status).toBe(404);
    expect(recorder.tableCalls).toEqual([]);
  });

  it.each(["main--some-branch", "master--some-branch", "deploy-preview--123", "some--invalid--name"])("counts nothing for the branch or preview build %s", async (courseId) => {
    const response = await visit(courseId);

    expect(response.status).toBe(204);
    expect(recorder.tableCalls).toEqual([]);
  });
});
