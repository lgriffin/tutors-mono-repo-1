/**
 * The edges of the community services the scenario suites pass by: the anonymous reader's
 * early returns, listeners handed payloads they cannot use, notices de-duplicated per tab, and
 * the reasons a snippet share reports when the store refuses it.
 */
import "../../bdd/support/svelte-runes-shim.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../packages/platform/logger/src/index.ts", () => ({
  default: { error: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), setDefaultLevel: vi.fn() }
}));

import { FixedClock, InMemoryCourseNotices, InMemoryPresence, InMemoryProfile } from "../../../packages/application/src/testing/index.ts";
import type { LecturerBroadcast, SnippetSharedNotice, SnippetStore } from "../../../packages/application/src/ports/index.ts";
import type { PresenceEvent } from "../../../packages/domain/src/presence/index.ts";
import { anonymousAdapters, configureAdapters } from "../../../packages/adapters/driving/svelte-state/src/adapters.ts";
import { analyticsService } from "../../../packages/adapters/driving/svelte-state/src/community/services/analytics.svelte.ts";
import { liveService } from "../../../packages/adapters/driving/svelte-state/src/community/services/live.svelte.ts";
import { noticeService } from "../../../packages/adapters/driving/svelte-state/src/community/services/notices.ts";
import { presenceService } from "../../../packages/adapters/driving/svelte-state/src/community/services/presence.svelte.ts";
import { snippetService } from "../../../packages/adapters/driving/svelte-state/src/community/services/snippets.ts";
import log from "../../../packages/platform/logger/src/index.ts";

const event = (courseId: string, id: string, loRoute = "/topic/x"): PresenceEvent => ({
  courseId,
  courseUrl: `${courseId}.netlify.app`,
  courseTitle: courseId,
  loRoute,
  title: "x",
  isPrivate: false,
  type: "topic",
  user: { id, fullName: id, avatar: "", sentiment: "neutral" }
});

afterEach(() => {
  liveService.stopGlobalPresenceService();
  liveService.stopCoursePresenceListener();
  presenceService.stopPresenceListener();
  noticeService.reset();
  configureAdapters(anonymousAdapters());
  vi.clearAllMocks();
});

describe("analyticsService when the composition is broken", () => {
  const course = { courseId: "cs101", route: "/course/cs101" } as never;
  const lo = { route: "/lab/cs101/lab-1", type: "lab" } as never;
  const student = { login: "ann" } as never;

  it("logs, rather than throws, when recording cannot even start", () => {
    configureAdapters({ ...anonymousAdapters(), anonymous: false, publisher: undefined as never });
    expect(() => analyticsService.reportPageLoad(course, lo, student)).not.toThrow();
    expect(() => analyticsService.updatePageCount(course, lo, student)).not.toThrow();
    expect(log.error).toHaveBeenCalledTimes(2);
    expect(vi.mocked(log.error).mock.calls[0][0]).toBe("TutorStore Error:");
  });

  it("stores no sharing choice for a learner who never made one, and no name when there is none", async () => {
    const profile = new InMemoryProfile();
    configureAdapters({ ...anonymousAdapters(), anonymous: false, profile: { local: profile, signedIn: null } });
    await analyticsService.updateLogin("cs101", { user: { login: "ann", share: "false" } as never });
    await analyticsService.updateLogin("cs101", { user: { login: "bob" } as never });
    expect(profile.learners.get("ann")).toMatchObject({ name: null, sharing: false });
    expect(profile.learners.get("bob")).toMatchObject({ name: null, sharing: null });
  });
});

describe("liveService", () => {
  let presence: InMemoryPresence;
  beforeEach(() => {
    presence = new InMemoryPresence(new FixedClock());
    configureAdapters({ ...anonymousAdapters({ presence }), anonymous: false });
  });

  it("ignores payloads without a learner or a course", () => {
    liveService.studentListener({ type: "broadcast", event: "lo-event", payload: { courseId: "cs101" } });
    liveService.courseListener({ type: "broadcast", event: "lo-event", payload: { user: { id: "ann" } } });
    liveService.broadcastListener({ type: "broadcast", event: "lo-event", payload: null });
    expect(liveService.studentsOnline.value).toEqual([]);
    expect(liveService.coursesOnline.value).toEqual([]);
  });

  it("listens to one course's learners, moving a learner rather than listing them twice", async () => {
    liveService.startCoursePresenceListener("cs101");
    await presence.publish(event("cs101", "ann", "/topic/1"));
    await presence.publish(event("cs101", "ann", "/topic/2"));
    await presence.publish(event("cs102", "bob"));
    expect(liveService.listeningForCourse.value).toBe("cs101");
    expect(liveService.studentsOnline.value.map((r) => [r.user?.id, r.loRoute])).toEqual([["ann", "/topic/2"]]);

    liveService.startCoursePresenceListener("cs101");
    expect(liveService.studentsOnline.value).toHaveLength(1);
  });

  it("starts the global listener once, and not at all in the anonymous reader", async () => {
    await liveService.startGlobalPresenceService();
    await liveService.startGlobalPresenceService();
    await presence.publish(event("cs101", "ann"));
    expect(liveService.coursesOnline.value).toHaveLength(1);
    liveService.stopGlobalPresenceService();

    configureAdapters({ anonymous: true });
    await liveService.startGlobalPresenceService();
    liveService.startCoursePresenceListener("cs101");
    await presence.publish(event("cs101", "ann"));
    expect(liveService.listeningAll).toBe(false);
    expect(liveService.listeningForCourse.value).toBe("");
    expect(liveService.coursesOnline.value).toEqual([]);
  });
});

describe("presenceService in the anonymous reader", () => {
  it("starts neither the live listener nor the roster", async () => {
    configureAdapters({ ...anonymousAdapters(), anonymous: true });
    await presenceService.startPresenceListener("cs101");
    await presenceService.startCourseRoster("cs101");
    expect(presenceService.listening).toBe(false);
    expect(presenceService.listeningTo).toBe("");
  });

  it("does not read a roster it is not keeping", async () => {
    const presence = new InMemoryPresence();
    const recent = vi.spyOn(presence, "recent");
    configureAdapters({ ...anonymousAdapters({ presence }), anonymous: false });
    await presenceService.refreshCourseRoster();
    expect(recent).not.toHaveBeenCalled();
  });
});

describe("noticeService", () => {
  let notices: InMemoryCourseNotices;
  beforeEach(() => {
    notices = new InMemoryCourseNotices();
    noticeService.reset();
    configureAdapters({ ...anonymousAdapters({ notices }), anonymous: false });
  });

  const ping = (id: string): SnippetSharedNotice => ({ type: "gist-created", id, courseId: "cs101", sentAt: 1 });

  it("tells every educator view in the tab about a shared snippet, once per notice", async () => {
    const a: string[] = [];
    const b: string[] = [];
    noticeService.onSnippetShared("cs101", (n) => a.push(n.id));
    const stopB = noticeService.onSnippetShared("cs101", (n) => b.push(n.id));
    await notices.post(ping("n1"));
    await notices.post(ping("n1"));
    stopB();
    await notices.post(ping("n2"));
    expect(a).toEqual(["n1", "n2"]);
    expect(b).toEqual(["n1"]);
  });

  it("remembers only the most recent 256 notices it showed", async () => {
    const heard: string[] = [];
    noticeService.onSnippetShared("cs101", (n) => heard.push(n.id));
    for (let i = 0; i <= 256; i++) await notices.post(ping(`n${i}`));
    await notices.post(ping("n0"));
    await notices.post(ping("n256"));
    expect(heard).toHaveLength(258);
    expect(heard.at(-1)).toBe("n0");
  });

  it("watches nothing without a course or in the anonymous reader, and an unsubscribe after reset is harmless", async () => {
    const heard: LecturerBroadcast[] = [];
    noticeService.onLecturerBroadcast("", (b) => heard.push(b))();
    const stop = noticeService.onLecturerBroadcast("cs101", (b) => heard.push(b));
    noticeService.reset();
    expect(() => stop()).not.toThrow();

    configureAdapters({ anonymous: true });
    const stopAnon = noticeService.onSnippetShared("cs101", () => heard.push({} as never));
    await notices.post(ping("n1"));
    stopAnon();
    expect(heard).toEqual([]);
  });
});

describe("snippetService.share when the store refuses", () => {
  const input = { courseId: "cs101", filename: "main.py", content: "print(1)" };
  const learner = { login: "ann", name: "Ann" };
  const refusing = (reason: unknown): SnippetStore => ({ add: async () => Promise.reject(reason), active: async () => [], countSince: async () => 0 });

  it.each([
    [new Error("Too many snippets this hour"), "Too many snippets this hour"],
    [new Error(""), null],
    ["a bare string", null]
  ])("reports %j as message %j", async (reason, message) => {
    configureAdapters({ ...anonymousAdapters({ snippets: refusing(reason) }), anonymous: false });
    expect(await snippetService.share(input, learner)).toEqual({ ok: false, message });
  });

  it("fills in a filename and leaves out empty optional fields", async () => {
    const add = vi.fn(async () => "s-1");
    configureAdapters({ ...anonymousAdapters({ snippets: { add, active: async () => [], countSince: async () => 0 } }), anonymous: false });
    expect(await snippetService.share({ ...input, filename: " ", title: " ", loRoute: "/lab/1 " }, learner)).toEqual({ ok: true, id: "s-1" });
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ filename: "snippet.txt", title: null, loRoute: "/lab/1", loTitle: null, expiresAt: "" }));
  });
});
