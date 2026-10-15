import { afterEach, describe, expect, it, vi } from "vitest";

import { createDataApi, dataApiErrorTransport } from "../../../packages/adapters/driven/data-api/src/index.ts";

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
