/**
 * The HTTP live-event reporter's browser lifecycle: the heartbeat while the page is visible, the
 * beacon when it goes away, and where the session token is kept. The queueing and batching rules
 * are in tests/unit/live/emitter.test.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveEvent, SidStorage } from "@tutors/domain/live";
import { browserStorage, httpLiveEventReporter } from "@tutors/live-events-http";

const ENDPOINT = "https://live.example/api/live/events";

function memoryStorage(): SidStorage {
  const items = new Map<string, string>();
  return { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => void items.set(key, value) };
}

/** A page: `document.hidden` and the window's pagehide listeners. */
function page() {
  const listeners = new Map<string, Set<() => void>>();
  const doc = { hidden: false };
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", {
    addEventListener: (type: string, fn: () => void) => listeners.set(type, (listeners.get(type) ?? new Set()).add(fn)),
    removeEventListener: (type: string, fn: () => void) => listeners.get(type)?.delete(fn)
  });
  return { doc, hide: () => [...(listeners.get("pagehide") ?? [])].forEach((fn) => fn()), listening: () => listeners.get("pagehide")?.size ?? 0 };
}

function build(overrides: Parameters<typeof httpLiveEventReporter>[0] = {}) {
  const posted: LiveEvent[][] = [];
  const fetchStub = vi.fn(async (_url: string, init?: { body?: unknown }) => {
    posted.push(JSON.parse(String(init?.body)) as LiveEvent[]);
    return new Response(null, { status: 202 });
  });
  const beacons: LiveEvent[][] = [];
  const reporter = httpLiveEventReporter({
    endpoint: ENDPOINT,
    fetch: fetchStub as unknown as typeof fetch,
    storage: memoryStorage(),
    heartbeatMs: 1000,
    sendBeacon: (_url, body) => (beacons.push(JSON.parse(body) as LiveEvent[]), true),
    ...overrides
  });
  return { reporter, posted, beacons };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("heartbeat", () => {
  it("beats on the learning object when there is one, and opens the session first", () => {
    const { reporter } = build();
    reporter.heartbeat("cs101", "/lab/1");
    reporter.heartbeat("cs101");
    expect(reporter.pending().map((event) => [event.type, "lo" in event ? event.lo : undefined])).toEqual([
      ["session.started", undefined],
      ["session.heartbeat", "/lab/1"],
      ["session.heartbeat", undefined]
    ]);
  });

  it("does nothing without an endpoint", () => {
    const reporter = httpLiveEventReporter({ storage: memoryStorage() });
    reporter.heartbeat("cs101", "/lab/1");
    reporter.sessionEnded("cs101");
    reporter.flushBeacon();
    expect(reporter.pending()).toEqual([]);
  });
});

describe("start", () => {
  it("beats and flushes on every interval while the page is visible, and skips the beat while it is hidden", async () => {
    vi.useFakeTimers();
    const { doc } = page();
    const { reporter, posted } = build();
    let lo: string | undefined = "/lab/1";
    const stop = reporter.start(() => "cs101", () => lo);

    await vi.advanceTimersByTimeAsync(1000);
    expect(posted.flat().map((event) => event.type)).toEqual(["session.started", "session.heartbeat"]);

    doc.hidden = true;
    lo = undefined;
    await vi.advanceTimersByTimeAsync(1000);
    expect(posted.flat()).toHaveLength(2);

    doc.hidden = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(posted.flat().at(-1)).toMatchObject({ type: "session.heartbeat", course: "cs101" });
    expect(posted.flat().at(-1)).not.toHaveProperty("lo");
    stop();
  });

  it("does not beat while no course is open", async () => {
    vi.useFakeTimers();
    page();
    const { reporter, posted } = build();
    const stop = reporter.start(() => undefined, () => undefined);
    await vi.advanceTimersByTimeAsync(3000);
    expect(posted).toEqual([]);
    stop();
  });

  it("ends the session and beacons the queue when the page is hidden for good", () => {
    const view = page();
    let now = new Date("2026-09-17T10:00:00.000Z");
    const { reporter, beacons } = build({ now: () => now });
    reporter.start(() => "cs101", () => undefined);
    reporter.courseOpened("cs101");
    now = new Date("2026-09-17T10:05:00.000Z");

    view.hide();

    expect(beacons.flat().map((event) => event.type)).toEqual(["session.started", "course.opened", "session.ended"]);
    expect(beacons.flat().at(-1)).toMatchObject({ durationSec: 300 });
    expect(reporter.pending()).toEqual([]);
  });

  it("only beacons on page hide when no course is open", () => {
    const view = page();
    const { reporter, beacons } = build();
    reporter.start(() => undefined, () => undefined);
    reporter.courseOpened("cs101");
    view.hide();
    expect(beacons.flat().map((event) => event.type)).toEqual(["session.started", "course.opened"]);
  });

  it("unregisters the interval and the page-hide listener", async () => {
    vi.useFakeTimers();
    const view = page();
    const { reporter, posted } = build();
    const stop = reporter.start(() => "cs101", () => undefined);
    expect(view.listening()).toBe(1);

    stop();
    await vi.advanceTimersByTimeAsync(5000);

    expect(view.listening()).toBe(0);
    expect(posted).toEqual([]);
  });

  it("registers nothing outside a browser, or without an endpoint", () => {
    const { reporter } = build();
    expect(reporter.start(() => "cs101", () => undefined)).toBeTypeOf("function");
    const view = page();
    httpLiveEventReporter({ storage: memoryStorage() }).start(() => "cs101", () => undefined)();
    expect(view.listening()).toBe(0);
  });
});

describe("flushBeacon", () => {
  it("sends the queue as a JSON blob through navigator.sendBeacon by default", async () => {
    const sendBeacon = vi.fn<(url: string, body: Blob) => boolean>(() => true);
    vi.stubGlobal("navigator", { sendBeacon });
    const { reporter } = build({ sendBeacon: undefined });
    reporter.courseOpened("cs101");

    reporter.flushBeacon();

    const [url, blob] = sendBeacon.mock.calls[0];
    expect(url).toBe(ENDPOINT);
    expect(blob.type).toBe("application/json");
    expect((JSON.parse(await blob.text()) as LiveEvent[]).map((event) => event.type)).toEqual(["session.started", "course.opened"]);
  });

  it("reports a beacon that throws, rather than breaking the page", () => {
    const onError = vi.fn();
    const { reporter } = build({
      onError,
      sendBeacon: () => {
        throw new Error("beacon too large");
      }
    });
    reporter.courseOpened("cs101");
    reporter.flushBeacon();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "beacon too large" }));
  });
});

describe("browserStorage", () => {
  it("is localStorage in a browser, and null outside one or where it is blocked", () => {
    expect(browserStorage()).toBeNull();

    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    expect(browserStorage()).toBe(storage);

    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("The operation is insecure.", "SecurityError");
      }
    });
    expect(browserStorage()).toBeNull();
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it("is where the reporter keeps its session token by default", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    const reporter = httpLiveEventReporter({ endpoint: ENDPOINT });
    expect(httpLiveEventReporter({ endpoint: ENDPOINT }).sid).toBe(reporter.sid);
  });
});
