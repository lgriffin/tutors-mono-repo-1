/**
 * The data API client and the application ports over it, against a fake reader server. The browser
 * sends; the server knows who is asking from the session, so no learner id is ever sent. A 401 (not
 * signed in) or 503 (no database) is an expected answer; anything else unsuccessful is a failure the
 * port reports, and an unreachable server is "nothing" rather than a crash.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Course } from "@tutors/domain/course";
import {
  createDataApi,
  readerApiAccessStore,
  readerApiCourseVisit,
  readerApiLearningEventSink,
  readerApiPlaygroundSnapshots,
  readerApiPresenceRoster,
  readerApiPresenceStore,
  readerApiProfile,
  readerApiScormRecords,
  readerApiWhiteboardStore
} from "@tutors/data-api";
import log from "@tutors/logger";

vi.mock("@tutors/logger", () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

type Call = { method: string; path: string; body: unknown; credentials?: string };

/** A reader server: answers each "METHOD path" from the table (status 200 and `{}` by default) and records every request. */
function server(routes: Record<string, { status?: number; body?: unknown } | Error> = {}) {
  const calls: Call[] = [];
  const fetchFn = vi.fn(async (path: string, init?: Parameters<typeof fetch>[1]) => {
    const method = init?.method ?? "GET";
    calls.push({ method, path, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)), credentials: init?.credentials });
    const route = routes[`${method} ${path.split("?")[0]}`] ?? {};
    if (route instanceof Error) throw route;
    return Response.json(route.body ?? {}, { status: route.status ?? 200 });
  });
  return { api: createDataApi(fetchFn), calls, fetchFn };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(log.warn).mockClear();
});

describe("createDataApi", () => {
  it("sends JSON with the session cookie, and no body or content type on a read", async () => {
    const { api, calls, fetchFn } = server({ "GET /api/me": { body: { sentiment: "fine", online_status: "online" } } });

    expect(await api.getMyStatus()).toEqual({ sentiment: "fine", online_status: "online" });
    await api.changeMyStatus({ sentiment: "fine" });

    expect(calls).toEqual([
      { method: "GET", path: "/api/me", body: undefined, credentials: "same-origin" },
      { method: "PATCH", path: "/api/me", body: { sentiment: "fine" }, credentials: "same-origin" }
    ]);
    expect(fetchFn.mock.calls[0][1]).toMatchObject({ headers: undefined });
    expect(fetchFn.mock.calls[1][1]).toMatchObject({ headers: { "content-type": "application/json" } });
  });

  it("logs a failed call but not an expected 401 or 503, and returns the response either way", async () => {
    const { api } = server({ "PUT /api/me": { status: 500 }, "PUT /api/profile": { status: 401 }, "PUT /api/locks": { status: 503 } });

    expect((await api.saveMe({}))?.status).toBe(500);
    expect((await api.saveProfile({ courseVisits: [] }))?.status).toBe(401);
    expect((await api.setLock({ courseId: "cs101", loRoute: "/lab/1", locked: true }))?.status).toBe(503);

    expect(log.warn).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledWith("Data API call failed", { method: "PUT", path: "/api/me", status: 500 });
  });

  it("answers null when the server cannot be reached, or a read is unsuccessful", async () => {
    const { api } = server({ "POST /api/analytics": new TypeError("Failed to fetch"), "GET /api/profile": { status: 401 } });

    expect(await api.recordAnalytics({ kind: "tick", courseId: "cs101", loId: null, day: "2026-09-17" })).toBeNull();
    expect(await api.getProfile()).toBeNull();
    expect(log.warn).toHaveBeenCalledWith("Data API unreachable", { method: "POST", path: "/api/analytics", error: "Failed to fetch" });
  });

  it("reports a thrown non-error as text", async () => {
    const api = createDataApi(() => Promise.reject("socket hang up"));
    expect(await api.removeLock({ courseId: "cs101", loRoute: "/lab/1" })).toBeNull();
    expect(log.warn).toHaveBeenCalledWith("Data API unreachable", { method: "DELETE", path: "/api/locks", error: "socket hang up" });
  });

  it("asks for a whiteboard room by course, route and whether it is shared", async () => {
    const { api, calls } = server({ "GET /api/whiteboard": { body: { scene: { elements: [] } } } });
    expect(await api.getWhiteboard({ courseId: "cs101", route: "/talk/1", shared: true })).toEqual({ scene: { elements: [] } });
    expect(calls[0].path).toBe("/api/whiteboard?courseId=cs101&route=%2Ftalk%2F1&shared=true");
  });

  it("uses the platform's fetch by default", async () => {
    const platform = vi.fn(async () => Response.json({}));
    vi.stubGlobal("fetch", platform);
    await createDataApi().reportPresence({ courseId: "cs101", payload: {} });
    expect(platform).toHaveBeenCalledWith("/api/presence", expect.objectContaining({ method: "POST" }));
  });
});

describe("readerApiLearningEventSink", () => {
  it("records a page load with its learning object, and a tick, without the learner", async () => {
    const { api, calls } = server();
    const sink = readerApiLearningEventSink(api);

    await sink.record({ kind: "page-load", courseId: "cs101", loId: "/lab/1", loType: "lab", day: "2026-09-17" }, "ann");
    await sink.record({ kind: "tick", courseId: "cs101", loId: null, day: "2026-09-17" }, "ann");

    expect(calls.map((call) => call.body)).toEqual([
      { kind: "page-load", courseId: "cs101", loId: "/lab/1", loType: "lab", day: "2026-09-17" },
      { kind: "tick", courseId: "cs101", loId: null, day: "2026-09-17" }
    ]);
  });

  it("sends nothing for no learner, no course, or a page load with no learning object", async () => {
    const { api, calls } = server();
    const sink = readerApiLearningEventSink(api);
    await sink.record({ kind: "tick", courseId: "cs101", loId: null, day: "d" }, "");
    await sink.record({ kind: "tick", courseId: "", loId: null, day: "d" }, "ann");
    await sink.record({ kind: "page-load", courseId: "cs101", loId: "", loType: "lab", day: "d" }, "ann");
    expect(calls).toEqual([]);
  });
});

describe("readerApiProfile", () => {
  it("reads the signed-in learner's visits, sentiment and sharing", async () => {
    const { api } = server({ "GET /api/profile": { body: { courseVisits: [{ id: "cs101" }] } }, "GET /api/me": { body: { sentiment: "delighted", online_status: "offline" } } });
    const profile = readerApiProfile(api);

    expect(await profile.getCourseVisits("ann")).toEqual([{ id: "cs101" }]);
    expect(await profile.getSentiment("ann")).toBe("delighted");
    expect(await profile.getSharing("ann")).toBe(false);
  });

  it("reads nothing for nobody, and an empty history when the server has none", async () => {
    const { api, calls } = server({ "GET /api/profile": { status: 401 } });
    const profile = readerApiProfile(api);

    expect(await profile.getCourseVisits("")).toEqual([]);
    expect(await profile.getSentiment("")).toBeNull();
    expect(await profile.getSharing("")).toBeNull();
    expect(calls).toEqual([]);
    expect(await profile.getCourseVisits("ann")).toEqual([]);
  });

  it("writes visits, sentiment and sharing for the session, and nothing for nobody", async () => {
    const { api, calls } = server();
    const profile = readerApiProfile(api);

    await profile.saveCourseVisits("", []);
    await profile.setSentiment("", "fine");
    await profile.setSharing("", true);
    await profile.upsertLearner({ login: "", name: "", email: null, image: null, sentiment: null, sharing: null });
    expect(calls).toEqual([]);

    await profile.saveCourseVisits("ann", [{ id: "cs101" } as never]);
    await profile.setSentiment("ann", "fine");
    await profile.setSharing("ann", true);
    await profile.upsertLearner({ login: "ann", name: "Ann", email: null, image: null, sentiment: "confused", sharing: false });
    await profile.upsertLearner({ login: "ann", name: "Ann", email: null, image: null, sentiment: "not a mood", sharing: null });

    expect(calls.map((call) => [call.method, call.path, call.body])).toEqual([
      ["PUT", "/api/profile", { courseVisits: [{ id: "cs101" }] }],
      ["PATCH", "/api/me", { sentiment: "fine" }],
      ["PATCH", "/api/me", { onlineStatus: "online" }],
      ["PUT", "/api/me", { sentiment: "confused", onlineStatus: "offline" }],
      ["PUT", "/api/me", {}]
    ]);
  });

  it("fails a write the server rejected, but not one it could not take (signed out, no database)", async () => {
    const failing = readerApiProfile(server({ "PUT /api/profile": { status: 500 }, "PUT /api/me": { status: 400 }, "PATCH /api/me": { status: 500 } }).api);
    await expect(failing.saveCourseVisits("ann", [])).rejects.toThrow("Saving the profile failed with status 500");
    await expect(failing.upsertLearner({ login: "ann", name: "", email: null, image: null, sentiment: null, sharing: true })).rejects.toThrow("Saving the student record failed with status 400");
    await expect(failing.setSentiment("ann", "fine")).rejects.toThrow("Saving the sentiment failed with status 500");
    await expect(failing.setSharing("ann", false)).rejects.toThrow("Saving the online status failed with status 500");

    const signedOut = readerApiProfile(server({ "PUT /api/profile": { status: 401 }, "PATCH /api/me": { status: 503 } }).api);
    await signedOut.saveCourseVisits("ann", []);
    await signedOut.setSharing("ann", true);

    const offline = readerApiProfile(createDataApi(() => Promise.reject(new TypeError("offline"))));
    await offline.setSentiment("ann", "fine");
  });
});

describe("readerApiAccessStore", () => {
  it("reads locks and changes them through the server", async () => {
    const { api, calls } = server({ "GET /api/locks": { body: { locks: [{ loRoute: "/lab/1" }] } }, "DELETE /api/locks": { status: 403 } });
    const store = readerApiAccessStore(api);

    expect(await store.locks("cs101")).toEqual([{ loRoute: "/lab/1" }]);
    expect(await store.setLock("cs101", "/lab/1", true, "ignored")).toBe(true);
    expect(await store.removeLock("cs101", "/lab/1")).toBe(false);
    expect(calls.map((call) => [call.method, call.path, call.body])).toEqual([
      ["GET", "/api/locks?courseId=cs101", undefined],
      ["PUT", "/api/locks", { courseId: "cs101", loRoute: "/lab/1", locked: true }],
      ["DELETE", "/api/locks", { courseId: "cs101", loRoute: "/lab/1" }]
    ]);
  });

  it("changes nothing without a course and a route, or when the server cannot be reached", async () => {
    const { api, calls } = server();
    const store = readerApiAccessStore(api);
    expect(await store.locks("")).toEqual([]);
    expect(await store.setLock("", "/lab/1", true, "x")).toBe(false);
    expect(await store.removeLock("cs101", "")).toBe(false);
    expect(calls).toEqual([]);

    const offline = readerApiAccessStore(createDataApi(() => Promise.reject(new TypeError("offline"))));
    expect(await offline.locks("cs101")).toEqual([]);
    expect(await offline.setLock("cs101", "/lab/1", true, "x")).toBe(false);
    expect(await offline.removeLock("cs101", "/lab/1")).toBe(false);
  });
});

describe("readerApiScormRecords", () => {
  const attempt = { courseId: "cs101", learnerId: "ada", loId: "/scorm/cs101/quiz", version: "2004" as const, cmi: { "cmi.location": "p3" }, summary: { completionStatus: "completed", successStatus: "passed", totalTime: 90, location: "p3" } };

  it("loads the session's saved state and saves an attempt without naming the learner", async () => {
    const { api, calls } = server({ "GET /api/scorm": { body: { cmi: { "cmi.location": "p3" } } } });
    const records = readerApiScormRecords(api);

    expect(await records.load("cs101", "ada", "/scorm/cs101/quiz")).toEqual({ "cmi.location": "p3" });
    await records.save(attempt);

    const { learnerId: _learnerId, ...sent } = attempt;
    expect(calls.map((call) => [call.method, call.path, call.body])).toEqual([
      ["GET", "/api/scorm?courseId=cs101&loId=%2Fscorm%2Fcs101%2Fquiz", undefined],
      ["PUT", "/api/scorm", sent]
    ]);
  });

  it("asks nothing without a course, a learner and a learning object, and starts from nothing when the server has no state", async () => {
    const { api, calls } = server({ "GET /api/scorm": { status: 503 } });
    const records = readerApiScormRecords(api);
    expect(await records.load("", "ada", "lo")).toEqual({});
    expect(await records.load("cs101", "", "lo")).toEqual({});
    expect(await records.load("cs101", "ada", "")).toEqual({});
    await records.save({ ...attempt, learnerId: "" });
    expect(calls).toEqual([]);

    expect(await records.load("cs101", "ada", "lo")).toEqual({});
  });

  it("logs a refused save, but not a signed-out or unconfigured one", async () => {
    for (const status of [500, 401, 503]) {
      vi.mocked(log.error).mockClear();
      const { api } = server({ "PUT /api/scorm": { status } });
      await readerApiScormRecords(api).save(attempt);
      expect(vi.mocked(log.error).mock.calls.length).toBe(status === 500 ? 1 : 0);
    }
  });
});

describe("readerApiPlaygroundSnapshots without a course or exercise", () => {
  it("answers nothing and asks the server nothing", async () => {
    const { api, calls } = server();
    const snapshots = readerApiPlaygroundSnapshots(api);
    const work = { studentId: "ada", studentName: "Ada", courseId: "", loId: "lo", runtime: "python", entry: "main.py", files: [], lastOutput: "", lastOk: null };

    expect(await snapshots.available("")).toBe(false);
    expect(await snapshots.reviews("")).toBe(false);
    expect(await snapshots.save(work)).toBe(false);
    expect(await snapshots.save({ ...work, courseId: "cs101", loId: "" })).toBe(false);
    expect(await snapshots.get("cs101", "lo", "")).toBeNull();
    expect(await snapshots.list("cs101", "")).toEqual([]);
    await snapshots.remove("", "lo");
    expect(calls).toEqual([]);
  });
});

describe("the realtime adapter's roster", () => {
  it("reads the stored roster through the server, answering null when the server cannot", async () => {
    const { api, calls } = server({ "GET /api/presence/roster": { body: { rows: [{ payload: { courseId: "cs101" } }] } } });

    expect(await readerApiPresenceRoster(api)("cs101", "2026-09-17T09:58:00.000Z")).toEqual([{ payload: { courseId: "cs101" } }]);
    expect(calls.map((call) => [call.method, call.path.split("?")[0], call.body])).toEqual([["GET", "/api/presence/roster", undefined]]);

    const down = server({ "GET /api/presence/roster": { status: 503 } }).api;
    expect(await readerApiPresenceRoster(down)(undefined, "2026-09-17T09:58:00.000Z")).toBeNull();
  });
});

describe("readerApiWhiteboardStore", () => {
  const shared = { courseId: "cs101", route: "/talk/1", shared: true };
  const personal = { ...shared, shared: false };

  it("loads and saves a room's scene", async () => {
    const { api, calls } = server({ "GET /api/whiteboard": { body: { scene: { elements: [1] } } } });
    const store = readerApiWhiteboardStore(api);
    expect(await store.load(shared, null)).toEqual({ elements: [1] });
    expect(await store.save(personal, "ann", [{ id: "e1" }])).toBe(true);
    expect(calls[1].body).toEqual({ ...personal, elements: [{ id: "e1" }] });
  });

  it("has no personal room for nobody, and nothing when the server has no scene or cannot be reached", async () => {
    const { api, calls } = server({ "GET /api/whiteboard": { body: {} } });
    const store = readerApiWhiteboardStore(api);
    expect(await store.load(personal, null)).toBeNull();
    expect(await store.save(personal, null, [])).toBe(false);
    expect(calls).toEqual([]);
    expect(await store.load(shared, null)).toBeNull();

    const offline = readerApiWhiteboardStore(createDataApi(() => Promise.reject(new TypeError("offline"))));
    expect(await offline.save(shared, null, [])).toBe(false);
  });
});

describe("readerApiPresenceStore and readerApiCourseVisit", () => {
  it("reports the learner's latest learning object under its course, and nothing without one", async () => {
    const { api, calls } = server();
    const store = readerApiPresenceStore(api);
    const event = { courseId: " cs101 ", loRoute: "/lab/1" } as never;
    await store(event);
    await store({ courseId: "  " } as never);
    expect(calls).toEqual([{ method: "POST", path: "/api/presence", body: { courseId: "cs101", payload: { courseId: " cs101 ", loRoute: "/lab/1" } }, credentials: "same-origin" }]);
  });

  it("reports a course visit for the catalogue, with whether the course is private and without the visit count", async () => {
    const { api, calls } = server();
    const course = { courseId: "cs101", courseUrl: "cs101.netlify.app", title: "CS 101", isPrivate: true, properties: { credits: "5" }, img: "logo.png" } as unknown as Course;

    await readerApiCourseVisit(api)(course, new Date("2026-09-17T10:00:00.000Z"));

    const body = calls[0].body as { courseId: string; courseRecord: Record<string, unknown> };
    expect(calls[0].path).toBe("/api/courses/visit");
    expect(body.courseId).toBe("cs101");
    expect(body.courseRecord).toMatchObject({ id: "cs101", private: true, lastVisit: "2026-09-17T10:00:00.000Z" });
    expect(body.courseRecord).not.toHaveProperty("visits");
  });
});
