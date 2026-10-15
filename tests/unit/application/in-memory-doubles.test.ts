/**
 * The rest of the in-memory adapters and recording doubles in @tutors/application/testing: the
 * parts the port contract suites do not reach (they are shaped by what the tests and the
 * anonymous reader need, not by a port contract).
 */
import { describe, expect, it } from "vitest";
import {
  InMemoryAccessStore,
  InMemoryCourseFacts,
  InMemoryLearningRecords,
  InMemoryPlaygroundSnapshots,
  InMemoryWhiteboardStore,
  PassThroughRenderer,
  inMemoryPresenceStore,
  inMemoryWarehouse,
  RecordingLiveEventReporter,
  ScriptedCodeRuntime,
  ScriptedCodeRuntimePort
} from "@tutors/application/testing";
import type { RuntimeEvent } from "@tutors/application/ports";
import type { CourseFacts } from "@tutors/domain/access";
import type { Course, Lo } from "@tutors/domain/course";
import type { LiveEvent } from "@tutors/domain/live";

describe("InMemoryLearningRecords.timeRows", () => {
  it("gathers the course's calendar, records and the learners in either, without their emails", async () => {
    const records = new InMemoryLearningRecords(
      [
        { id: "2026-01-04", courseid: "cs101", studentid: "ann", pageloads: 1, duration: 1 },
        { id: "2026-01-06", courseid: "cs101", studentid: "cal", pageloads: 1, duration: 1 }
      ] as never,
      [{ course_id: "cs101", student_id: "bob", lo_id: "/topic/1" }] as never,
      [
        { github_id: "ann", email: "ann@x" },
        { github_id: "bob", email: "bob@x" },
        { github_id: "cal", email: "cal@x" },
        { github_id: "dee", email: "dee@x" }
      ] as never
    );
    const rows = await records.timeRows("cs101", "2026-01-05");
    expect(rows).toMatchObject({ courseId: "cs101", role: "educator", course: null, assignments: [] });
    expect(rows.calendar.map((r) => r.id)).toEqual(["2026-01-06"]);
    expect(rows.learningRecords).toHaveLength(1);
    expect(rows.users).toEqual([{ github_id: "bob" }, { github_id: "cal" }]);
  });
});

describe("InMemoryCourseFacts", () => {
  const facts = (courseId: string): CourseFacts => ({ courseId, title: courseId, educators: ["eve"], isPrivate: false, credits: null });

  it("finds a published course, misses a removed one, and cannot reach one marked unreachable", async () => {
    const source = new InMemoryCourseFacts({ cs101: facts("cs101") });
    source.publish(facts("cs102"));
    expect(await source.lookup("cs102")).toEqual({ kind: "found", facts: facts("cs102") });
    source.remove("cs101");
    expect(await source.lookup("cs101")).toEqual({ kind: "missing" });
    source.unreachable.add("cs102");
    expect(await source.lookup("cs102")).toEqual({ kind: "unavailable" });
    expect(source.lookups).toEqual(["cs102", "cs101", "cs102"]);
  });

  it("starts with no courses", async () => {
    expect(await new InMemoryCourseFacts().lookup("cs101")).toEqual({ kind: "missing" });
  });
});

describe("InMemoryWhiteboardStore", () => {
  const shared = { courseId: "cs101", route: "/lab/1", shared: true };
  const personal = { ...shared, shared: false };

  it("keeps one shared scene per room whoever saves it", async () => {
    const store = new InMemoryWhiteboardStore();
    expect(await store.load(shared, null)).toBeNull();
    expect(await store.save(shared, "ann", [{ id: 1 }])).toBe(true);
    expect(await store.load(shared, "bob")).toEqual({ elements: [{ id: 1 }], appState: {}, files: {} });
  });

  it("keeps a personal scene per owner, and refuses a personal save with no owner", async () => {
    const store = new InMemoryWhiteboardStore();
    expect(await store.save(personal, null, [{ id: 1 }])).toBe(false);
    expect(await store.save(personal, "ann", [{ id: 2 }])).toBe(true);
    expect(await store.load(personal, "ann")).toMatchObject({ elements: [{ id: 2 }] });
    expect(await store.load(personal, "bob")).toBeNull();
    expect(await store.load(shared, null)).toBeNull();
  });
});

describe("InMemoryPlaygroundSnapshots", () => {
  const snapshot = { studentId: "ann", studentName: "Ann", courseId: "cs101", loId: "/lab/1", runtime: "python", entry: "main.py", files: [], lastOutput: "", lastOk: null };

  it("offers nothing when handing in is disabled", async () => {
    const snapshots = new InMemoryPlaygroundSnapshots({ enabled: false, reviews: ["cs101"] });
    expect(await snapshots.available()).toBe(false);
    expect(await snapshots.reviews("cs101")).toBe(false);
    expect(await snapshots.save(snapshot)).toBe(false);
    expect(await snapshots.get("cs101", "/lab/1", "ann")).toBeNull();
    expect(await snapshots.list("cs101", "/lab/1")).toEqual([]);
  });

  it("is enabled by default, reviews only the courses it was given, and stamps saves with the clock", async () => {
    const snapshots = new InMemoryPlaygroundSnapshots();
    expect(await snapshots.available()).toBe(true);
    expect(await snapshots.reviews("cs101")).toBe(false);
    expect(await snapshots.save(snapshot)).toBe(true);
    expect((await snapshots.get("cs101", "/lab/1", "ann"))?.updatedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(await new InMemoryPlaygroundSnapshots({ reviews: ["cs101"] }).reviews("cs101")).toBe(true);
  });
});

describe("InMemoryPlaygroundSnapshots refusals", () => {
  it("refuses a snapshot that does not name its course, exercise and student", async () => {
    const snapshots = new InMemoryPlaygroundSnapshots();
    const base = { studentId: "ann", studentName: "Ann", courseId: "cs101", loId: "/lab/1", runtime: "python", entry: "main.py", files: [], lastOutput: "", lastOk: null };
    for (const missing of ["courseId", "loId", "studentId"]) expect(await snapshots.save({ ...base, [missing]: "" })).toBe(false);
    expect(snapshots.rows).toEqual([]);
  });
});

describe("InMemoryAccessStore.removeLock", () => {
  it("refuses to remove a lock without a course or a route, and removes one it holds", async () => {
    const store = new InMemoryAccessStore();
    await store.setLock("cs101", "/lab/1", true, "eve");
    expect(await store.removeLock("", "/lab/1")).toBe(false);
    expect(await store.removeLock("cs101", "")).toBe(false);
    expect(await store.removeLock("cs101", "/lab/1")).toBe(true);
    expect(await store.locks("cs101")).toEqual([]);
  });
});

describe("PassThroughRenderer", () => {
  it("leaves a learning object with no text or summary as it was", () => {
    const lo = { title: "Empty" } as Lo;
    new PassThroughRenderer().renderLo({} as Course, lo);
    expect(lo).toEqual({ title: "Empty" });
  });
});

describe("ScriptedCodeRuntime", () => {
  it("reports its lifecycle: started, restarted (also by stop), disposed", async () => {
    const events: RuntimeEvent[] = [];
    const runtime = new ScriptedCodeRuntime({ runtime: "python", onEvent: (e) => events.push(e) });
    expect([runtime.isStarted, runtime.isDisposed, runtime.restartCount]).toEqual([false, false, 0]);
    await runtime.start();
    await runtime.start();
    expect(runtime.isStarted).toBe(true);
    expect(events.filter((e) => e.type === "ready")).toHaveLength(1);
    runtime.restart();
    runtime.stop();
    expect(runtime.restartCount).toBe(2);
    expect(events.at(-1)).toEqual({ type: "status", phase: "idle", detail: "Run-time restarted" });
    runtime.dispose();
    expect(runtime.isDisposed).toBe(true);
    await expect(runtime.execute({ runtime: "python", mode: "script", files: [], entry: "main.py" })).rejects.toThrow("disposed");
  });

  it("emits a scripted error with a trailing newline in the output, and stops telling an unsubscribed listener", async () => {
    const runtime = new ScriptedCodeRuntime({ runtime: "python" }).script({ stderr: "warn\n", error: "Boom" }, { error: "Again\n", ok: true }, { value: "42" });
    const heard: RuntimeEvent[] = [];
    const stop = runtime.subscribe((e) => heard.push(e));
    const failed = await runtime.execute({ runtime: "python", mode: "cell", files: [], entry: "main.py", id: "run-a" });
    expect(failed).toEqual({ ok: false, output: "warn\nBoom\n", stderr: "warn\nBoom", value: "", error: "Boom", durationMs: 0 });
    expect(heard).toContainEqual({ type: "error", id: "run-a", message: "Boom" });
    stop();
    const second = await runtime.execute({ runtime: "python", mode: "cell", files: [], entry: "main.py" });
    expect(second).toMatchObject({ ok: true, output: "Again\n" });
    expect(heard.some((e) => "id" in e && e.id === "exec-1")).toBe(false);
    expect((await runtime.execute({ runtime: "python", mode: "cell", files: [], entry: "main.py" })).value).toBe("42");
  });
});

describe("ScriptedCodeRuntimePort", () => {
  it("opens run-times scripted with its answers and keeps each one", async () => {
    const port = new ScriptedCodeRuntimePort([{ stdout: "hi\n" }]);
    const runtime = port.open({ runtime: "javascript" });
    expect(runtime.runtime).toBe("javascript");
    expect((await runtime.execute({ runtime: "javascript", mode: "script", files: [], entry: "main.js" })).output).toBe("hi\n");
    expect(port.opened).toEqual([runtime]);
    expect((await new ScriptedCodeRuntimePort().open({ runtime: "python" }).execute({ runtime: "python", mode: "script", files: [], entry: "m.py" })).ok).toBe(true);
  });
});

describe("RecordingLiveEventReporter", () => {
  const at = new Date("2026-01-05T09:00:00.000Z");

  it("opens one session per course visit, records what the reader reports, and closes it once", async () => {
    const reporter = new RecordingLiveEventReporter(true, () => at);
    reporter.identify("u-1");
    reporter.loViewed("cs101", "/lab/1", "lab");
    reporter.serviceUsed("cs101", "pdf");
    reporter.heartbeat("cs101", "/lab/1");
    reporter.heartbeat("cs101");
    reporter.sessionEnded("cs101");
    reporter.sessionEnded("cs101");
    const ts = at.toISOString();
    const sid = "2026-01-05.recording";
    expect(reporter.pending()).toEqual([
      { type: "session.started", ts, sid, course: "cs101", uid: "u-1" },
      { type: "lo.viewed", ts, sid, course: "cs101", lo: "/lab/1", loType: "lab" },
      { type: "service.used", ts, sid, course: "cs101", service: "pdf" },
      { type: "session.heartbeat", ts, sid, course: "cs101", lo: "/lab/1" },
      { type: "session.heartbeat", ts, sid, course: "cs101" },
      { type: "session.ended", ts, sid, course: "cs101", durationSec: 0 }
    ]);
    reporter.heartbeat("cs102");
    expect(reporter.pending().at(-1)).toEqual({ type: "session.heartbeat", ts, sid, course: "cs102" });
    expect(reporter.pending().at(-2)).toEqual({ type: "session.started", ts, sid, course: "cs102", uid: "u-1" });
    expect(reporter.uid).toBe("u-1");
  });

  it("records nothing when disabled, but still counts flushes and starts", async () => {
    const reporter = new RecordingLiveEventReporter(false, undefined, "sid-x");
    expect(reporter.sid).toBe("sid-x");
    reporter.courseOpened("cs101");
    reporter.loViewed("cs101", "/a", "lab");
    reporter.sessionEnded("cs101");
    expect(reporter.pending()).toEqual([]);
    await reporter.flush();
    reporter.flushBeacon();
    expect(reporter.flushes).toBe(2);
    const stop = reporter.start();
    reporter.start();
    expect(reporter.started).toBe(2);
    stop();
    expect(reporter.started).toBe(1);
  });
});

describe("inMemoryPresenceStore", () => {
  it("forgets service touches once they fall out of the service window", async () => {
    const hot = inMemoryPresenceStore();
    const t0 = Date.parse("2026-01-05T09:00:00.000Z");
    const used = (sid: string, ms: number): LiveEvent => ({ type: "service.used", ts: new Date(ms).toISOString(), sid, course: "cs101", service: "pdf" });
    await hot.touch(used("s1", t0));
    await hot.touch(used("s2", t0 + 6 * 60_000));
    const snapshot = await hot.now(new Date(t0 + 6 * 60_000));
    expect(snapshot.activeSessions).toBe(1);
    expect(snapshot.services.find((s) => s.service === "pdf")?.count).toBe(1);
  });
});

describe("inMemoryWarehouse", () => {
  it("holds at most maxEvents raw events, dropping the oldest", async () => {
    const now = new Date("2026-01-05T09:30:00.000Z");
    const warehouse = inMemoryWarehouse({ maxEvents: 2, now: () => now });
    const view = (lo: string, minute: number): LiveEvent => ({ type: "lo.viewed", ts: `2026-01-05T09:0${minute}:00.000Z`, sid: "s1", course: "cs101", lo, loType: "lab" });
    await warehouse.append([view("/a", 1), view("/b", 2), view("/c", 3)]);
    const range = { from: new Date("2026-01-05T09:00:00.000Z"), to: now };
    expect((await warehouse.topLos(range, 10)).map((row) => row.lo)).toEqual(["/b", "/c"]);
  });
});
