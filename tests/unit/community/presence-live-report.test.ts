import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "../../bdd/support/svelte-runes-shim.ts";
import type { Course, Lo } from "../../../packages/domain/src/course/index.ts";

/**
 * A learning event leaves the browser once, as a fire-and-forget POST to the reader's server, which
 * publishes it to Tutors Live. The browser publishes nothing over realtime itself, even with a Live
 * course stream open in the same tab. The report failing, by rejecting or by `fetch` throwing
 * synchronously, must not stop the latest-LO upsert, and must reach the log.
 */

vi.mock("@tutors/logger", () => ({
  default: { error: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), setDefaultLevel: vi.fn() }
}));

import { REALTIME_STREAM_ROUTE, valkeyBrowserRealtime, type EventSourceLike } from "@tutors/realtime-valkey";
import { configureAdapters, anonymousAdapters } from "../../../packages/adapters/driving/svelte-state/src/adapters.ts";
import { presenceService } from "../../../packages/adapters/driving/svelte-state/src/community/services/presence.svelte.ts";
import log from "@tutors/logger";

const LIVE_ACTIVITY_ROUTE = "/api/live/activity";

const course = { courseId: "web-dev", courseUrl: "web-dev.netlify.app", title: "Web Development", properties: {} } as unknown as Course;
const lo = { title: "Lab 1", route: "/lab/web-dev/lab-1", img: "lab-1.png", type: "lab" } as unknown as Lo;
const student = { login: "alice", name: "Alice", image: "alice.png", share: "true" } as never;

const mockUpsert = vi.fn();
/** The browser's `fetch`: the report to the reader's server, and any publish the tab might attempt. */
const mockFetch = vi.fn();
/** The streams this tab opened: a Live course stream is open while the event is sent. */
const streams: string[] = [];

/** What the reader composes as the snapshot store: the data API's POST /api/presence (never a table write from the browser). */
const store = (event: unknown) => mockUpsert(event) as Promise<void>;

function eventSource(url: string): EventSourceLike {
  streams.push(url);
  const source: EventSourceLike = { onopen: null, onmessage: null, onerror: null, close: () => {} };
  queueMicrotask(() => source.onopen?.({}));
  return source;
}

async function sendAndSettle() {
  presenceService.sendLoEvent(course, lo, student);
  await Promise.resolve();
  await Promise.resolve();
}

describe("presence over Valkey: a learning event goes to the reader's server, not over the stream", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockUpsert.mockResolvedValue(undefined);
    streams.length = 0;
    // An anonymous id is minted from localStorage even for a student who shares their name.
    vi.stubGlobal("window", { localStorage: { tutorsTimeId: "anon-1" } });
    vi.stubGlobal("fetch", mockFetch);
    const realtime = valkeyBrowserRealtime({ eventSource, fetch: mockFetch, presence: { store } });
    configureAdapters({ ...anonymousAdapters(), anonymous: false, presence: realtime.presence });
    presenceService.stopPresenceListener();
    // A Live course stream open in this tab: the event must not be published on it either.
    await presenceService.startPresenceListener("web-dev");
  });

  afterEach(() => {
    presenceService.stopPresenceListener();
    configureAdapters(anonymousAdapters());
    vi.unstubAllGlobals();
  });

  it("posts the record once with keepalive, upserts it, and publishes nothing", async () => {
    mockFetch.mockResolvedValue(new Response(null, { status: 202 }));

    await sendAndSettle();

    expect(streams).toEqual([`${REALTIME_STREAM_ROUTE}?topic=web-dev`]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, NonNullable<Parameters<typeof fetch>[1]>];
    expect(url).toBe(LIVE_ACTIVITY_ROUTE);
    expect(init).toMatchObject({ method: "POST", keepalive: true, headers: { "content-type": "application/json" } });
    expect(JSON.parse(String(init.body))).toMatchObject({ courseId: "web-dev", title: "Lab 1", user: { id: "alice" } });
    expect(mockUpsert).toHaveBeenCalledWith(expect.objectContaining({ courseId: "web-dev", title: "Lab 1" }));
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("logs a rejected report and still upserts", async () => {
    mockFetch.mockRejectedValue(new TypeError("Failed to fetch"));

    await sendAndSettle();

    expect(log.warn).toHaveBeenCalledWith("Reporting live activity failed:", expect.any(TypeError));
    expect(mockUpsert).toHaveBeenCalledWith(expect.objectContaining({ courseId: "web-dev", title: "Lab 1" }));
  });

  it("logs a fetch that throws synchronously and still upserts", async () => {
    mockFetch.mockImplementation(() => {
      throw new TypeError("keepalive body too large");
    });

    await sendAndSettle();

    expect(log.warn).toHaveBeenCalledWith("Reporting live activity failed:", expect.any(TypeError));
    expect(mockUpsert).toHaveBeenCalledWith(expect.objectContaining({ courseId: "web-dev", title: "Lab 1" }));
  });
});
