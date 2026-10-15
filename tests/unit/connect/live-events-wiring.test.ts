import { beforeEach, describe, expect, it } from "vitest";
import { configureAdapters } from "@tutors/svelte-state/adapters";
import { httpLiveEventReporter } from "@tutors/live-events-http";
import type { LiveEventReporter } from "@tutors/application/ports";
import {
  optInToLiveEvents,
  optOutOfLiveEvents,
  reportCourseOpened,
  reportLoViewed,
  reportServiceUsed
} from "../../../packages/adapters/driving/svelte-state/src/connect/services/live-events.ts";

/**
 * What the reader reports to Tutors Live.
 *
 * The behaviour that matters here is the one that separates live events from
 * analytics: they carry no identity, so they are emitted in anonymous mode too,
 * and an identifier only ever appears for someone who opted in.
 *
 * The reporter is whatever the composition root installed: here the HTTP one
 * with an endpoint and no network (nothing is flushed), so each test reads the
 * events its own calls queued.
 */

let reporter: LiveEventReporter;

beforeEach(() => {
  reporter = httpLiveEventReporter({ endpoint: "https://live.example/api/live/events", storage: null, fetch: async () => new Response(null, { status: 202 }) });
  configureAdapters({ liveEvents: reporter });
});

/** The events `act` added to the queue. */
function emittedBy(act: () => void) {
  const before = reporter.pending().length;
  act();
  return reporter.pending().slice(before);
}

describe("reader live events", () => {
  it("is enabled once the composition root installs a reporter with an endpoint", () => {
    expect(reporter.enabled).toBe(true);
  });

  it("opens a session on the first course, carrying the rotating token and no identity", () => {
    const emitted = emittedBy(() => reportCourseOpened("cs101"));

    expect(emitted.map((event) => event.type)).toEqual(["session.started", "course.opened"]);
    expect(emitted.every((event) => event.sid === reporter.sid)).toBe(true);
    expect(emitted[0]).not.toHaveProperty("uid");
  });

  it("does not open a second session while the first is still going", () => {
    reportCourseOpened("cs101");
    const emitted = emittedBy(() => reportCourseOpened("cs101"));
    expect(emitted.map((event) => event.type)).toEqual(["course.opened"]);
  });

  it("reports a view and the service its type implies", () => {
    reportCourseOpened("cs101");
    const emitted = emittedBy(() => reportLoViewed("cs101", "/topic/1/lab-1", "lab"));

    expect(emitted.map((event) => event.type)).toEqual(["lo.viewed", "service.used"]);
    expect(emitted.at(-1)).toMatchObject({ service: "lab", course: "cs101" });
  });

  it("reports a view whose type has no service without inventing one", () => {
    reportCourseOpened("cs101");
    const emitted = emittedBy(() => reportLoViewed("cs101", "/topic/1", "topic"));
    expect(emitted.map((event) => event.type)).toEqual(["lo.viewed"]);
  });

  it("ignores a report with no course or no route rather than emitting a half-formed event", () => {
    const emitted = emittedBy(() => {
      reportLoViewed("", "/topic/1", "lab");
      reportLoViewed("cs101", "", "lab");
    });
    expect(emitted).toEqual([]);
  });

  it("reports a service used on its own, for the ones no learning object implies", () => {
    reportCourseOpened("cs101");
    const emitted = emittedBy(() => reportServiceUsed("cs101", "search"));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ type: "service.used", service: "search" });
  });

  it("stamps a hashed identifier on the next session once a learner opts in, and drops it on opt-out", async () => {
    await optInToLiveEvents("aoife");
    const optedIn = emittedBy(() => reportCourseOpened("cs101"));

    const started = optedIn.find((event) => event.type === "session.started") as { uid?: string } | undefined;
    expect(started?.uid).toMatch(/^[0-9a-f]{32}$/);
    expect(started?.uid).not.toContain("aoife");

    optOutOfLiveEvents();
    const optedOut = emittedBy(() => {
      reporter.sessionEnded("cs101");
      reportCourseOpened("cs101");
    });
    expect(optedOut.find((event) => event.type === "session.started")).not.toHaveProperty("uid");
  });

  it("reports nothing through the anonymous reader's default, which has no endpoint", () => {
    const silent = httpLiveEventReporter({ storage: null });
    configureAdapters({ liveEvents: silent });
    reportCourseOpened("cs101");
    reportLoViewed("cs101", "/topic/1/lab-1", "lab");
    expect(silent.enabled).toBe(false);
    expect(silent.pending()).toEqual([]);
  });
});
