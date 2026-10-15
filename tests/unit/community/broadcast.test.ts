// @vitest-environment happy-dom
/**
 * The lecturer -> student toast broadcast (issue #78), folded onto the CourseNotices port.
 *
 * The browser publishes nothing: `noticeService.sendLecturerBroadcast` runs the
 * `broadcastToCourse` use case over the composed CourseNotices adapter, whose `post` is the
 * reader server's job in production (POST /api/notices). Here the in-memory adapter delivers
 * posts straight to its watchers, which stands in for Supabase echoing the publish back to every
 * tab on the course topic.
 */
import "../../bdd/support/svelte-runes-shim.ts";
import { beforeEach, describe, expect, it } from "vitest";
import { noticeService } from "../../../packages/adapters/driving/svelte-state/src/community/services/notices.ts";
import { anonymousAdapters, configureAdapters } from "../../../packages/adapters/driving/svelte-state/src/adapters.ts";
import { broadcastToCourse, createBroadcastLimiter, BROADCAST_RATE_LIMIT_MS } from "../../../packages/application/src/index.ts";
import { FixedClock, InMemoryCourseNotices } from "../../../packages/application/src/testing/index.ts";
import type { LecturerBroadcast } from "../../../packages/application/src/ports/index.ts";

const MSG = { title: "Quiz open", description: "Head to lab 02", actionUrl: "/lab-02", actionLabel: "Start" };

let notices: InMemoryCourseNotices;
let clock: FixedClock;

beforeEach(() => {
  notices = new InMemoryCourseNotices();
  clock = new FixedClock();
  noticeService.reset();
  configureAdapters({ ...anonymousAdapters({ notices, clock }), anonymous: false });
});

function broadcastFor(overrides: Partial<LecturerBroadcast> = {}): LecturerBroadcast {
  return { type: "course:broadcast", id: `bc-${Math.random().toString(36).slice(2)}`, courseId: "cs101", title: "t", description: "d", senderName: "A", sentAt: 1, ...overrides };
}

describe("broadcastToCourse (use case)", () => {
  const send = () => broadcastToCourse({ notices, clock, limiter: createBroadcastLimiter() });

  it("posts a well-formed broadcast to the course", async () => {
    const result = await send()("cs101", MSG, "Alice");
    expect(result.ok).toBe(true);
    expect(notices.posted).toHaveLength(1);
    expect(notices.posted[0]).toMatchObject({ type: "course:broadcast", courseId: "cs101", title: "Quiz open", description: "Head to lab 02", actionUrl: "/lab-02", actionLabel: "Start", senderName: "Alice", sentAt: clock.nowMs() });
    expect(typeof notices.posted[0].id).toBe("string");
  });

  it("is rate-limited to one broadcast per course per 60s", async () => {
    const broadcast = send();
    expect((await broadcast("cs101", MSG, "Alice")).ok).toBe(true);
    clock.advance(30_000);
    expect(await broadcast("cs101", MSG, "Alice")).toEqual({ ok: false, reason: "rate-limited" });
    clock.advance(BROADCAST_RATE_LIMIT_MS - 30_000 + 1);
    expect((await broadcast("cs101", MSG, "Alice")).ok).toBe(true);
  });

  it("scopes the limit per course", async () => {
    const broadcast = send();
    expect((await broadcast("course-a", MSG, "Alice")).ok).toBe(true);
    clock.advance(1_000);
    expect((await broadcast("course-b", MSG, "Alice")).ok).toBe(true);
  });

  it("falls back to 'Tutor' when no sender name is given", async () => {
    await send()("cs101", MSG, "");
    expect((notices.posted[0] as LecturerBroadcast).senderName).toBe("Tutor");
  });

  it("refuses an empty title or description without posting", async () => {
    const broadcast = send();
    expect(await broadcast("cs101", { title: "", description: "d" }, "A")).toEqual({ ok: false, reason: "empty" });
    expect(await broadcast("cs101", { title: "t", description: "" }, "A")).toEqual({ ok: false, reason: "empty" });
    expect(notices.posted).toHaveLength(0);
  });

  it("reports a failed post when no broker is configured", async () => {
    const unconfigured = new InMemoryCourseNotices(false);
    const result = await broadcastToCourse({ notices: unconfigured, clock, limiter: createBroadcastLimiter() })("cs101", MSG, "A");
    expect(result).toEqual({ ok: false, reason: "failed" });
  });
});

describe("noticeService.sendLecturerBroadcast", () => {
  it("sends through the composed notices adapter", async () => {
    expect(await noticeService.sendLecturerBroadcast("cs101", MSG, "Alice")).toBe(true);
    expect(notices.posted).toHaveLength(1);
  });

  it("refuses in an anonymous composition", async () => {
    configureAdapters({ anonymous: true });
    expect(await noticeService.sendLecturerBroadcast("cs101", MSG, "Alice")).toBe(false);
    expect(notices.posted).toHaveLength(0);
  });
});

describe("noticeService.onLecturerBroadcast (delivery, exactly-once, isolation)", () => {
  it("delivers a broadcast posted by another client to the handler", async () => {
    const seen: LecturerBroadcast[] = [];
    const stop = noticeService.onLecturerBroadcast("cs101", (b) => seen.push(b));
    const payload = broadcastFor({ id: "remote-1", title: "Break time", description: "Be back in 10", senderName: "Alice" });
    await notices.post(payload);
    expect(seen).toEqual([payload]);
    stop();
  });

  it("shows the sender's own tab exactly one toast from the echo", async () => {
    const seen: LecturerBroadcast[] = [];
    noticeService.onLecturerBroadcast("cs101", (b) => seen.push(b));
    await noticeService.sendLecturerBroadcast("cs101", MSG, "Alice");
    // The in-memory adapter echoes the post to the sender's own watcher, as Supabase does.
    expect(seen).toHaveLength(1);
  });

  it("shows a replayed notice only once per tab", async () => {
    const seen: LecturerBroadcast[] = [];
    noticeService.onLecturerBroadcast("cs101", (b) => seen.push(b));
    const payload = broadcastFor({ id: "replayed" });
    await notices.post(payload);
    await notices.post(payload);
    expect(seen).toHaveLength(1);
  });

  it("ignores broadcasts for a different course", async () => {
    const seen: LecturerBroadcast[] = [];
    noticeService.onLecturerBroadcast("cs101", (b) => seen.push(b));
    await notices.post(broadcastFor({ courseId: "other-course", id: "other-1" }));
    expect(seen).toHaveLength(0);
  });

  it("unsubscribing stops further delivery", async () => {
    const seen: LecturerBroadcast[] = [];
    const stop = noticeService.onLecturerBroadcast("cs101", (b) => seen.push(b));
    stop();
    await notices.post(broadcastFor({ id: "after-1" }));
    expect(seen).toHaveLength(0);
  });

  it("keeps delivering to healthy handlers when one throws", async () => {
    const seen: LecturerBroadcast[] = [];
    noticeService.onLecturerBroadcast("cs101", () => {
      throw new Error("boom");
    });
    noticeService.onLecturerBroadcast("cs101", (b) => seen.push(b));
    await notices.post(broadcastFor({ id: "two-1" }));
    expect(seen).toHaveLength(1);
  });

  it("hears nothing in an anonymous composition", async () => {
    configureAdapters({ anonymous: true });
    const seen: LecturerBroadcast[] = [];
    noticeService.onLecturerBroadcast("cs101", (b) => seen.push(b));
    await notices.post(broadcastFor({ id: "anon-1" }));
    expect(seen).toHaveLength(0);
  });
});
