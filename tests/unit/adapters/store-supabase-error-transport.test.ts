/**
 * The Supabase error transport: warnings and errors are buffered and written to `app_errors` in
 * batches (every five seconds, or at once when twenty are waiting), never anything quieter, never
 * without a client, and never by throwing into the app. The unload beacon has its own test in
 * tests/unit/community/error-transport.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureSupabase, createSupabaseErrorTransport } from "@tutors/store-supabase";

type Insert = ReturnType<typeof vi.fn>;

function clientWith(insert: Insert) {
  return { from: vi.fn(() => ({ insert })) };
}

const entry = (level: string, message: string, extra: Record<string, unknown> = {}) => ({ timestamp: "2026-09-17T10:00:00.000Z", level, message, app: "ignored", ...extra }) as never;

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  configureSupabase(undefined);
});

describe("createSupabaseErrorTransport", () => {
  it("writes buffered warnings and errors as one batch after five seconds, tagged with the app", async () => {
    const insert = vi.fn(async () => ({ error: null }));
    const client = clientWith(insert);
    configureSupabase(client as never);
    const send = createSupabaseErrorTransport("reader");

    send(entry("warn", "slow", { courseId: "cs101", studentId: "ann", route: "/lab/1" }));
    send(entry("error", "boom"));
    send(entry("info", "ignored"));
    send(entry("debug", "ignored"));
    expect(insert).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5000);

    expect(client.from).toHaveBeenCalledWith("app_errors");
    expect(insert).toHaveBeenCalledOnce();
    const rows = insert.mock.calls[0][0] as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ app: "reader", level: "warn", message: "slow", context: { courseId: "cs101", studentId: "ann", route: "/lab/1" }, url: null, course_id: "cs101", student_id: "ann" });
    expect(rows[1]).toMatchObject({ app: "reader", level: "error", message: "boom", context: {}, course_id: null, student_id: null });
  });

  it("writes at once when twenty entries are waiting, without waiting for the timer", async () => {
    const insert = vi.fn(async () => ({ error: null }));
    configureSupabase(clientWith(insert) as never);
    const send = createSupabaseErrorTransport("time");

    for (let i = 0; i < 20; i++) send(entry("error", `e${i}`));

    expect(insert).toHaveBeenCalledOnce();
    expect((insert.mock.calls[0][0] as unknown[]).length).toBe(20);
    await vi.advanceTimersByTimeAsync(5000);
    expect(insert).toHaveBeenCalledOnce();
  });

  it("buffers nothing while there is no Supabase", async () => {
    const send = createSupabaseErrorTransport("reader");
    send(entry("error", "lost"));

    const insert = vi.fn(async () => ({ error: null }));
    configureSupabase(clientWith(insert) as never);
    await vi.advanceTimersByTimeAsync(5000);

    expect(insert).not.toHaveBeenCalled();
  });

  it("drops the batch when Supabase goes away before it is written", async () => {
    const insert = vi.fn(async () => ({ error: null }));
    configureSupabase(clientWith(insert) as never);
    const send = createSupabaseErrorTransport("reader");
    send(entry("error", "pending"));

    configureSupabase(undefined);
    await vi.advanceTimersByTimeAsync(5000);
    configureSupabase(clientWith(insert) as never);
    await vi.advanceTimersByTimeAsync(5000);

    expect(insert).not.toHaveBeenCalled();
  });

  it("swallows a failing insert rather than crashing the app", async () => {
    const insert = vi.fn(() => {
      throw new Error("network down");
    });
    configureSupabase(clientWith(insert) as never);
    const send = createSupabaseErrorTransport("reader");

    for (let i = 0; i < 20; i++) send(entry("error", `e${i}`));

    expect(insert).toHaveBeenCalledOnce();
  });

  it("sends nothing on unload when everything has already been written, or there is no URL to send to", async () => {
    let onUnload: () => void = () => {};
    const sendBeacon = vi.fn(() => true);
    vi.stubGlobal("window", { location: { href: "https://tutors.dev/x" }, addEventListener: (_type: string, fn: () => void) => (onUnload = fn) });
    vi.stubGlobal("navigator", { userAgent: "test", sendBeacon });
    const insert = vi.fn(async () => ({ error: null }));
    // The client is configured without the URL and key the beacon needs.
    configureSupabase(clientWith(insert) as never);
    const send = createSupabaseErrorTransport("reader");

    onUnload();
    send(entry("error", "late"));
    onUnload();

    expect(sendBeacon).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(insert).not.toHaveBeenCalled();
  });
});
