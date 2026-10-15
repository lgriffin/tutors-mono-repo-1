/**
 * Edges of three server-side use cases the scenario suites do not reach: the authorization
 * cache's admins and its bound, the heartbeat for a visitor, and the live ingestor's sweeper.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthorizationUnavailableError, createAuthorization, createIngestor, recordHeartbeat } from "@tutors/application";
import { FixedClock, InMemoryCourseFacts, InMemoryLearningEventSink, inMemoryLiveBus, inMemoryPresenceStore, inMemoryWarehouse } from "@tutors/application/testing";
import type { LiveWarehouse } from "@tutors/application/ports";
import type { CourseFacts } from "@tutors/domain/access";
import type { Course } from "@tutors/domain/course";
import type { LiveEvent } from "@tutors/domain/live";

const facts = (courseId: string, educators: string[] = []): CourseFacts => ({ courseId, title: courseId, educators, isPrivate: false, credits: null });
const course = (courseId: string) => ({ kind: "course" as const, courseId });

describe("createAuthorization", () => {
  it("treats an admin as an educator of every course without asking its host, and reads a course once while it is fresh", async () => {
    const courseFacts = new InMemoryCourseFacts({ cs101: facts("cs101", ["eve"]) });
    const auth = createAuthorization({ courseFacts, clock: new FixedClock(), admins: ["root"] });
    expect(await auth.can({ login: "root" }, "broadcast", course("unknown"))).toBe(true);
    expect(await auth.can({ login: "eve" }, "broadcast", course("cs101"))).toBe(true);
    expect(await auth.can({ login: "ann" }, "broadcast", course("cs101"))).toBe(false);
    expect(courseFacts.lookups).toEqual(["cs101"]);
  });

  it("holds at most 2000 courses, forgetting the oldest read and its fallback copy", async () => {
    const courseFacts = new InMemoryCourseFacts();
    for (let i = 0; i <= 2000; i++) courseFacts.publish(facts(`c${i}`));
    const auth = createAuthorization({ courseFacts, clock: new FixedClock() });
    for (let i = 0; i <= 2000; i++) await auth.course(`c${i}`);
    expect(await auth.course("c2000")).toEqual(facts("c2000"));
    expect(courseFacts.lookups.filter((id) => id === "c2000")).toHaveLength(1);

    courseFacts.unreachable.add("c0");
    courseFacts.unreachable.add("c1");
    await expect(auth.course("c0")).rejects.toBeInstanceOf(AuthorizationUnavailableError);
    expect(await auth.course("c1")).toEqual(facts("c1"));
  });
});

describe("recordHeartbeat", () => {
  it("records nothing for a visitor who is not signed in", async () => {
    const events = new InMemoryLearningEventSink();
    const published: unknown[] = [];
    const beat = recordHeartbeat({ events, clock: new FixedClock(), publish: async (e) => void published.push(e) });
    await beat(null, { courseId: "cs101" } as Course, null);
    await beat({ login: "" }, { courseId: "cs101" } as Course, null);
    expect(events.recorded).toEqual([]);
    expect(published).toEqual([]);
  });
});

describe("createIngestor sweeper", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const opened = (sid: string, ts: string): LiveEvent => ({ type: "course.opened", ts, sid, course: "cs101" });

  it("sweeps against the wall clock by default and closes a session gone idle", async () => {
    const ingestor = createIngestor({ hot: inMemoryPresenceStore(), warehouse: inMemoryWarehouse() });
    await ingestor.handle(opened("s1", new Date(Date.now() - 31 * 60_000).toISOString()));
    await ingestor.handle(opened("s2", new Date().toISOString()));
    expect(await ingestor.sweep()).toBe(1);
    expect(ingestor.openSessions()).toBe(1);
  });

  it("reports a session it could not store, without counting it as closed", async () => {
    const errors: unknown[] = [];
    const warehouse: LiveWarehouse = { ...inMemoryWarehouse(), upsertSession: async () => Promise.reject(new Error("db down")) };
    const ingestor = createIngestor({ hot: inMemoryPresenceStore(), warehouse, onError: (e) => errors.push(e) });
    await ingestor.handle(opened("s1", "2026-01-05T09:00:00.000Z"));
    expect(await ingestor.sweep(new Date("2026-01-05T10:00:00.000Z"))).toBe(0);
    expect(errors).toEqual([new Error("db down")]);
  });

  it("sweeps on its timer while running, and stops when told", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-05T09:00:00.000Z"));
    const bus = inMemoryLiveBus();
    const ingestor = createIngestor({ hot: inMemoryPresenceStore(), warehouse: inMemoryWarehouse(), idleMs: 60_000 });
    const stop = await ingestor.run(bus, 10_000);
    await bus.publish([opened("s1", "2026-01-05T09:00:00.000Z")]);
    expect(ingestor.openSessions()).toBe(1);
    await vi.advanceTimersByTimeAsync(70_000);
    expect(ingestor.openSessions()).toBe(0);
    await stop();
    await bus.publish([opened("s2", "2026-01-05T09:01:10.000Z")]);
    expect(ingestor.openSessions()).toBe(0);
  });
});
