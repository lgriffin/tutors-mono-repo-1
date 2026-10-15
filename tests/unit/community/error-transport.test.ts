import { afterEach, describe, expect, it, vi } from "vitest";

import { createDataApi, dataApiErrorTransport, MAX_REPORT_BYTES } from "../../../packages/adapters/driven/data-api/src/index.ts";

// Warnings and errors go to the reader's POST /api/errors, never to a table (Rule 0472).
describe("error transport", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function transport(base = "", navigator: Record<string, unknown> = {}) {
    let onUnload: (() => void) | undefined;
    vi.stubGlobal("window", {
      location: { href: "https://tutors.dev/note/course/x" },
      addEventListener: (type: string, fn: () => void) => {
        if (type === "beforeunload") onUnload = fn;
      }
    });
    vi.stubGlobal("navigator", { userAgent: "test", ...navigator });
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchFn);
    const send = dataApiErrorTransport("tutors-reader", createDataApi(fetchFn, base));
    return { send, fetchFn, unload: () => onUnload!() };
  }

  const entry = (level: string, message = "boom") => ({ timestamp: "t", level, message, app: "tutors-reader", courseId: "web-dev-101", studentId: "bob" }) as never;

  it("batches warnings and errors into one report to /api/errors, and drops the rest", async () => {
    vi.useFakeTimers();
    const { send, fetchFn } = transport();
    send(entry("info"));
    send(entry("warn", "slow"));
    send(entry("error"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("/api/errors");
    const report = JSON.parse(String(init?.body));
    expect(report.app).toBe("tutors-reader");
    expect(report.entries.map((e: { level: string }) => e.level)).toEqual(["warn", "error"]);
    // The student is the session's, so the browser does not send one.
    expect(report.entries[0]).toMatchObject({ courseId: "web-dev-101", url: "https://tutors.dev/note/course/x" });
    expect(JSON.stringify(report)).not.toContain("bob");
  });

  it("keeps a multi-line message on one line, so the route does not refuse the batch", async () => {
    vi.useFakeTimers();
    const { send, fetchFn } = transport();
    send(entry("error", "first line\n  at stack (file.ts:1)\r\n"));
    await vi.advanceTimersByTimeAsync(5000);
    const report = JSON.parse(String(fetchFn.mock.calls[0][1]?.body));
    expect(report.entries[0].message).toBe("first line   at stack (file.ts:1) ");
  });

  it("packs a burst of large errors into reports under the route's 16 KB limit, losing none", async () => {
    vi.useFakeTimers();
    const { send, fetchFn } = transport();
    const big = (i: number) => ({ ...(entry("error", `${i} ${"x".repeat(990)}`) as object), detail: "y".repeat(1500) }) as never;
    for (let i = 0; i < 20; i++) send(big(i));
    await vi.advanceTimersByTimeAsync(30_000);
    const reports = fetchFn.mock.calls.map(([, init]) => String(init?.body));
    expect(reports.length).toBeGreaterThan(1);
    for (const body of reports) expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(MAX_REPORT_BYTES);
    expect(reports.flatMap((body) => JSON.parse(body).entries)).toHaveLength(20);
  });

  it("replaces a context too large to report with a note", async () => {
    vi.useFakeTimers();
    const { send, fetchFn } = transport();
    send({ ...(entry("error") as object), body: "z".repeat(5000) } as never);
    await vi.advanceTimersByTimeAsync(5000);
    const report = JSON.parse(String(fetchFn.mock.calls[0][1]?.body));
    expect(report.entries[0].context).toEqual({ contextDropped: expect.stringMatching(/bytes$/) });
  });

  it("replaces a context that cannot be serialised with a note", async () => {
    vi.useFakeTimers();
    const { send, fetchFn } = transport();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    send({ ...(entry("error") as object), cycle } as never);
    await vi.advanceTimersByTimeAsync(5000);
    const report = JSON.parse(String(fetchFn.mock.calls[0][1]?.body));
    expect(report.entries[0].context).toEqual({ contextDropped: "not serialisable" });
  });

  it("survives a report that fails", async () => {
    vi.useFakeTimers();
    const { send, fetchFn } = transport();
    fetchFn.mockRejectedValue(new TypeError("offline"));
    for (let i = 0; i < 25; i++) send(entry("error", `boom ${i}`));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("sends nothing on unload with nothing buffered, and survives a fetch that throws", () => {
    const { send, fetchFn, unload } = transport("https://tutors.dev");
    unload();
    expect(fetchFn).not.toHaveBeenCalled();
    fetchFn.mockImplementation(() => {
      throw new TypeError("page is unloading");
    });
    send(entry("error"));
    expect(() => unload()).not.toThrow();
  });

  it("does not report its own failed reports, which would post forever", async () => {
    vi.useFakeTimers();
    const { send, fetchFn } = transport();
    send({ timestamp: "t", level: "warn", message: "Data API call failed", path: "/api/errors" } as never);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("beacons the buffer on unload from the reader's own origin", () => {
    const sendBeacon = vi.fn(() => true);
    const { send, fetchFn, unload } = transport("", { sendBeacon });
    send(entry("error"));
    unload();
    expect(sendBeacon).toHaveBeenCalledOnce();
    expect((sendBeacon.mock.calls[0] as unknown as [string])[0]).toBe("/api/errors");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("posts with keepalive on unload from another app, which a beacon cannot reach", () => {
    const sendBeacon = vi.fn(() => true);
    const { send, fetchFn, unload } = transport("https://tutors.dev", { sendBeacon });
    send(entry("error"));
    unload();
    expect(sendBeacon).not.toHaveBeenCalled();
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://tutors.dev/api/errors");
    expect(init).toMatchObject({ method: "POST", keepalive: true, headers: { "content-type": "application/json" } });
  });
});
