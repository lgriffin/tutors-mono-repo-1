import { describe, it, expect, vi, beforeEach } from "vitest";

// health-check reads `supabase` at call time and treats an absent client as anon mode, so the
// stub is held in a mutable binding the tests reassign rather than the shared MockSupabaseClient
// (which has no rpc).
let client: unknown;

import { configureSupabase } from "../../../packages/adapters/driven/store-supabase/src/client.ts";
import { checkSupabase, getRecentErrorCounts } from "../../../packages/adapters/driven/store-supabase/src/health-check.ts";

function clientReturning({ select, rpc }: { select?: unknown; rpc?: unknown } = {}) {
  return {
    from: vi.fn(() => ({ select: vi.fn(() => Promise.resolve(select)) })),
    rpc: vi.fn(() => Promise.resolve(rpc))
  };
}

beforeEach(() => {
  client = undefined;
  configureSupabase(client as never);
});

describe("checkSupabase", () => {
  it("skips the check when there is no client, so anon mode is not an error", async () => {
    expect(await checkSupabase()).toEqual({ status: "skipped", latencyMs: 0, message: "anon mode" });
  });

  it("reports ok and a latency when the count query answers", async () => {
    client = clientReturning({ select: { error: null } });
    configureSupabase(client as never);
    const result = await checkSupabase();
    expect(result.status).toBe("ok");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.message).toBeUndefined();
  });

  it("asks only for the row count, not the rows", async () => {
    const stub = clientReturning({ select: { error: null } });
    client = stub;
    configureSupabase(client as never);
    await checkSupabase();
    expect(stub.from).toHaveBeenCalledWith("tutors-connect-courses");
  });

  it("reports the error message when the query answers with one", async () => {
    client = clientReturning({ select: { error: { message: "permission denied" } } });
    configureSupabase(client as never);
    const result = await checkSupabase();
    expect(result).toMatchObject({ status: "error", message: "permission denied" });
  });

  it("reports the message when the query throws an Error", async () => {
    client = { from: vi.fn(() => ({ select: () => Promise.reject(new Error("network down")) })) };
    configureSupabase(client as never);
    const result = await checkSupabase();
    expect(result).toMatchObject({ status: "error", message: "network down" });
  });

  it("stringifies a thrown value that is not an Error", async () => {
    client = { from: vi.fn(() => ({ select: () => Promise.reject("gateway timeout") })) };
    configureSupabase(client as never);
    const result = await checkSupabase();
    expect(result).toMatchObject({ status: "error", message: "gateway timeout" });
  });
});

describe("getRecentErrorCounts", () => {
  it("returns nothing when there is no client", async () => {
    expect(await getRecentErrorCounts()).toEqual([]);
  });

  it("returns the counts the function reports", async () => {
    const counts = [{ app: "reader", level: "error", count: 3 }];
    client = clientReturning({ rpc: { data: counts, error: null } });
    configureSupabase(client as never);
    expect(await getRecentErrorCounts()).toEqual(counts);
  });

  it("asks for the last hour", async () => {
    const stub = clientReturning({ rpc: { data: [], error: null } });
    client = stub;
    configureSupabase(client as never);
    await getRecentErrorCounts();
    expect(stub.rpc).toHaveBeenCalledWith("get_error_counts", { minutes_ago: 60 });
  });

  it("returns nothing when the function answers with an error", async () => {
    client = clientReturning({ rpc: { data: null, error: { message: "no such function" } } });
    configureSupabase(client as never);
    expect(await getRecentErrorCounts()).toEqual([]);
  });

  it("returns nothing when the function answers with no data", async () => {
    client = clientReturning({ rpc: { data: null, error: null } });
    configureSupabase(client as never);
    expect(await getRecentErrorCounts()).toEqual([]);
  });

  it("returns nothing when the call throws, so a health page still renders", async () => {
    client = { rpc: () => Promise.reject(new Error("socket closed")) };
    configureSupabase(client as never);
    expect(await getRecentErrorCounts()).toEqual([]);
  });
});
