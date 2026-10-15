// @vitest-environment happy-dom
/**
 * The connect service in the browser: a learner coming back signed in, toggling sharing, and the
 * failures it logs rather than throws (a learner record or event bus that cannot be written must
 * never break the page). The community and RBAC services are stood in for, as in
 * course-visit-locks.test.ts, so only the connect service's own decisions are under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Both specifiers alias the one stub module (tests/support/sveltekit-stubs.ts), so each mock carries both exports.
const kit = vi.hoisted(() => ({ browser: true, goto: vi.fn() }));
vi.mock("$app/env", () => kit);
vi.mock("$app/navigation", () => kit);
vi.mock("../../../packages/platform/logger/src/index.ts", () => ({
  default: { error: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), setDefaultLevel: vi.fn() }
}));

vi.mock("../../../packages/adapters/driving/svelte-state/src/community/index.ts", () => ({
  analyticsService: { learningEvent: vi.fn(), reportPageLoad: vi.fn(), updatePageCount: vi.fn(), updateLogin: vi.fn(async () => {}) },
  presenceService: { startPresenceListener: vi.fn(), startCourseRoster: vi.fn(), stopPresenceListener: vi.fn(), sendLoEvent: vi.fn() }
}));

vi.mock("../../../packages/adapters/driving/svelte-state/src/index.svelte.ts", () => {
  const rune = <T>(initial: T) => ({ value: initial });
  return { rune, currentCourse: rune(null), currentLo: rune(null), tutorsId: rune(null), isEducator: rune(false) };
});

vi.mock("../../../packages/adapters/driving/svelte-state/src/rbac/index.ts", () => ({
  rbacService: { loadContentLocks: vi.fn(() => Promise.resolve()), clear: vi.fn(), loadRole: vi.fn(), checkLecturerStatus: vi.fn() }
}));

import type { Course } from "@tutors/tutors-model-lib";
import { InMemoryProfile, RecordingLiveEventReporter, RecordingPublisher } from "../../../packages/application/src/testing/index.ts";
import { anonymousAdapters, configureAdapters } from "../../../packages/adapters/driving/svelte-state/src/adapters.ts";
import { analyticsService, presenceService } from "../../../packages/adapters/driving/svelte-state/src/community/index.ts";
import { tutorsConnectService } from "../../../packages/adapters/driving/svelte-state/src/connect/services/connect.svelte.ts";
import { optInToLiveEvents } from "../../../packages/adapters/driving/svelte-state/src/connect/services/live-events.ts";
import { currentCourse, currentLo, tutorsId } from "../../../packages/adapters/driving/svelte-state/src/index.svelte.ts";
import log from "../../../packages/platform/logger/src/index.ts";

const ann = { login: "ann", name: "Ann", email: "ann@x", image: "" } as never;
const course = { courseId: "cs101", hasEnrollment: false, authLevel: 0 } as unknown as Course;
/** Let fire-and-forget promises and their catch handlers run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

let profile: InMemoryProfile;

function signedInComposition(overrides: Parameters<typeof anonymousAdapters>[0] = {}) {
  profile = new InMemoryProfile();
  configureAdapters({ ...anonymousAdapters({ profile: { local: new InMemoryProfile(), signedIn: profile }, ...overrides }), anonymous: false });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  tutorsId.value = null;
  currentCourse.value = null;
  currentLo.value = null;
  signedInComposition();
});

afterEach(() => {
  tutorsConnectService.stopTimer();
  configureAdapters(anonymousAdapters());
});

describe("reconnect", () => {
  it("restores the learner's stored mood and sharing, and returns them to the course they signed in from", async () => {
    await profile.setSentiment("ann", "happy" as never);
    await profile.setSharing("ann", true);
    localStorage.loginCourse = "cs101";
    currentCourse.value = course as never;

    await tutorsConnectService.reconnect(ann);

    expect(tutorsId.value).toMatchObject({ login: "ann", sentiment: "happy", share: "true" });
    expect(kit.goto).toHaveBeenCalledWith("/course/cs101");
    expect(localStorage.loginCourse).toBeUndefined();
    expect(presenceService.startCourseRoster).toHaveBeenCalledWith("cs101");
  });

  it("keeps the browser's own sharing choice once one is stored there", async () => {
    localStorage.share = "false";
    currentCourse.value = course as never;
    await tutorsConnectService.reconnect(ann);
    expect(tutorsId.value?.share).toBe("false");
    expect(kit.goto).not.toHaveBeenCalled();
    expect(presenceService.startCourseRoster).not.toHaveBeenCalled();
  });

  it("logs a learner record that could not be updated", async () => {
    vi.mocked(analyticsService.updateLogin).mockRejectedValueOnce(new Error("db down"));
    await tutorsConnectService.reconnect(ann);
    await settle();
    expect(log.error).toHaveBeenCalledWith("Failed to update student record:", new Error("db down"));
  });

  it("does nothing in the anonymous reader", async () => {
    configureAdapters({ anonymous: true });
    await tutorsConnectService.reconnect(ann);
    expect(tutorsId.value).toBeNull();
  });
});

describe("toggleShare and updateSentiment", () => {
  it("logs a sharing choice the learner record could not keep", async () => {
    tutorsId.value = { login: "ann", share: "false" } as never;
    vi.spyOn(profile, "setSharing").mockRejectedValueOnce(new Error("db down"));
    tutorsConnectService.toggleShare();
    await settle();
    expect(tutorsId.value?.share).toBe("true");
    expect(log.error).toHaveBeenCalledWith("Failed to update online status:", new Error("db down"));
  });

  it("keeps the mood in the browser only, in the anonymous reader", async () => {
    tutorsId.value = { login: "ann", sentiment: "neutral" } as never;
    configureAdapters({ anonymous: true });
    await tutorsConnectService.updateSentiment("happy");
    expect(localStorage.sentiment).toBe("happy");
    expect(tutorsId.value?.sentiment).toBe("neutral");
  });
});

describe("courseVisit when recording fails", () => {
  it("logs a visit that could not be published or stored", async () => {
    const publisher = new RecordingPublisher();
    vi.spyOn(publisher, "publish").mockRejectedValueOnce(new Error("bus down"));
    signedInComposition({ publisher });
    vi.spyOn(profile, "getCourseVisits").mockRejectedValueOnce(new Error("db down"));
    tutorsId.value = { login: "ann", share: "true" } as never;

    tutorsConnectService.courseVisit(course);
    await settle();

    expect(log.error).toHaveBeenCalledWith("Failed to publish course visit:", new Error("bus down"));
    expect(log.error).toHaveBeenCalledWith("Failed to log course visit:", new Error("db down"));
  });
});

describe("startTimer", () => {
  class CapturingReporter extends RecordingLiveEventReporter {
    where: Array<() => string | undefined> = [];
    override start(course?: () => string | undefined, lo?: () => string | undefined): () => void {
      this.where = [course!, lo!];
      return super.start();
    }
  }

  it("hands Tutors Live the course and learning object on screen, read at each beat", () => {
    const reporter = new CapturingReporter();
    configureAdapters({ liveEvents: reporter, anonymous: true });
    tutorsConnectService.startTimer();
    expect(reporter.started).toBe(1);
    expect(tutorsConnectService.intervalId).toBeNull();

    const [courseNow, loNow] = reporter.where;
    expect([courseNow(), loNow()]).toEqual([undefined, undefined]);
    currentCourse.value = course as never;
    currentLo.value = { route: "/lab/cs101/lab-1" } as never;
    expect([courseNow(), loNow()]).toEqual(["cs101", "/lab/cs101/lab-1"]);

    tutorsConnectService.stopTimer();
    expect(reporter.started).toBe(0);
  });
});

describe("optInToLiveEvents", () => {
  it("logs, and does not throw, when the learner cannot be identified", async () => {
    const reporter = new RecordingLiveEventReporter(true);
    vi.spyOn(reporter, "identify").mockImplementation(() => {
      throw new Error("no subtle crypto");
    });
    configureAdapters({ liveEvents: reporter });
    await expect(optInToLiveEvents("ann")).resolves.toBeUndefined();
    expect(log.debug).toHaveBeenCalledWith("live events could not hash the learner", { error: "Error: no subtle crypto" });
  });
});
