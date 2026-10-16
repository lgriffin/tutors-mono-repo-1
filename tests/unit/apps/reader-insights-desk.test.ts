/**
 * The browser's InsightsDesk over the reader's GET /api/insights (readerApiInsightsDesk): the
 * insights desk contract run through the data API client against the reader's own route handler,
 * each call made as the person signed in, over the in-memory read port; what each answer the reader
 * can give becomes; and the parsing of what Tutors Time asks.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { insightsDeskContract, InMemoryInsightsRead } from "@tutors/application/testing";
import { createDataApi, readerApiInsightsDesk } from "@tutors/data-api";

const server = vi.hoisted(() => ({
  data: null as unknown,
  educators: ["ellen"] as string[] | null,
  /** The course's auth level and whitelist; null when its tutors.json cannot be read. */
  access: {} as { authLevel?: number; enrollment?: { educators?: string[]; whitelist?: string[] } } | null,
  anonymous: false
}));
vi.mock("../../../apps/reader/src/lib/server/api/adapters.ts", () => ({ readerServer: () => ({ data: server.data }) }));
vi.mock("../../../apps/reader/src/lib/server/snippets.ts", () => ({
  educatorsOf: async (courseId: string) => {
    if (!server.educators) throw new Error("course unreachable");
    return courseId === "cs101" ? server.educators : [];
  },
  accessOf: async () => (server.access ? { ...server.access, enrollment: { educators: server.educators ?? [], ...server.access.enrollment } } : null)
}));
vi.mock("../../../apps/reader/src/lib/server/api/access.ts", () => ({ allowedOrigins: () => [] }));
vi.mock("@tutors/svelte-state/adapters", () => ({ adapters: () => ({ anonymous: server.anonymous }) }));

import { GET, OPTIONS } from "../../../apps/reader/src/routes/api/insights/+server.ts";
import { parseInsightsAsk } from "../../../apps/reader/src/lib/server/insights.ts";

const ORIGIN = "https://reader.test";

function readerAs(login: string | null) {
  return async (input: string, init?: RequestInit) => {
    const url = new URL(input, ORIGIN);
    const request = new Request(url, init);
    return GET({ request, url, locals: { actor: login ? { login, name: login, subject: `github:${login}` } : null }, fetch } as never);
  };
}
const deskAs = (login: string | null) => readerApiInsightsDesk(createDataApi(readerAs(login)));
const rows = () => new InMemoryInsightsRead([], [], []);

function fresh(read = rows()) {
  server.data = { insights: read };
  server.educators = ["ellen"];
  server.access = {};
  server.anonymous = false;
}

beforeEach(() => fresh());

describe("InsightsDesk: the reader's /api/insights", () => {
  for (const c of insightsDeskContract(({ requests, annotations, reflections }) => {
    fresh(new InMemoryInsightsRead(requests, annotations, reflections));
    return { educator: deskAs("ellen"), student: deskAs("alice"), visitor: deskAs(null) };
  })) {
    it(c.name, c.run);
  }
});

describe("GET /api/insights", () => {
  it("answers not-kept off Postgres, not-ready without the views, and unavailable when a read fails", async () => {
    server.data = { insights: null };
    expect(await deskAs("ellen").course("cs101", "day", "2026-01-05")).toEqual({ ok: false, reason: "not-kept" });
    const read = rows();
    fresh(read);
    read.failure = "not-ready";
    expect(await deskAs("ellen").course("cs101", "day", "2026-01-05")).toEqual({ ok: false, reason: "not-ready" });
    read.failure = "unavailable";
    expect(await deskAs("ellen").student("cs101", "alice", "day", "2026-01-05")).toEqual({ ok: false, reason: "unavailable" });
  });

  it("refuses a reader a private course does not admit, and answers unavailable when the course cannot be read", async () => {
    server.access = { authLevel: 1, enrollment: { whitelist: ["alice"] } };
    expect(await deskAs("mallory").course("cs101", "day", "2026-01-05")).toEqual({ ok: false, reason: "forbidden" });
    expect((await deskAs("ellen").course("cs101", "day", "2026-01-05")).ok).toBe(true);
    server.access = null;
    expect(await deskAs("ellen").course("cs101", "day", "2026-01-05")).toEqual({ ok: false, reason: "unavailable" });
    server.access = {};
    server.educators = null;
    expect(await deskAs("ellen").course("cs101", "day", "2026-01-05")).toEqual({ ok: false, reason: "unavailable" });
  });

  it("refuses everyone in anonymous mode, and a malformed ask", async () => {
    server.anonymous = true;
    expect(await deskAs("ellen").course("cs101", "day", "2026-01-05")).toEqual({ ok: false, reason: "signed-out" });
    server.anonymous = false;
    expect(await deskAs("ellen").course("cs101", "fortnight" as never, "2026-01-05")).toEqual({ ok: false, reason: "invalid" });
    expect(parseInsightsAsk(new URLSearchParams({}))).toMatch(/courseId/);
    expect(parseInsightsAsk(new URLSearchParams({ courseId: "x".repeat(201) }))).toMatch(/courseId/);
    expect(parseInsightsAsk(new URLSearchParams({ courseId: "cs101", day: "yesterday" }))).toMatch(/YYYY-MM-DD/);
    expect(parseInsightsAsk(new URLSearchParams({ courseId: "cs101", day: "2026-01-05", learnerId: "y".repeat(201) }))).toMatch(/learnerId/);
    expect(parseInsightsAsk(new URLSearchParams({ courseId: " cs101 ", day: "2026-01-05", learnerId: " " }))).toEqual({ courseId: "cs101", span: "day", day: "2026-01-05", learnerId: null });
  });

  it("answers the preflight and a read for a listed origin only", async () => {
    const event = (origin: string, method = "OPTIONS") =>
      ({ request: new Request(`${ORIGIN}/api/insights?courseId=cs101&day=2026-01-05`, { method, headers: { origin } }), url: new URL(`${ORIGIN}/api/insights?courseId=cs101&day=2026-01-05`), locals: { actor: null } }) as never;
    expect((await OPTIONS(event("https://evil.test"))).status).toBe(403);
    expect((await OPTIONS(event(ORIGIN))).status).toBe(204);
    expect((await GET(event("https://evil.test", "GET"))).status).toBe(403);
  });
});

describe("readerApiInsightsDesk answers", () => {
  const answering = (status: number, body: unknown) => readerApiInsightsDesk(createDataApi(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })));

  it("names the refusal the reader gave, and what a status with none means", async () => {
    expect(await answering(503, { reason: "not-ready" }).course("cs101", "day", "2026-01-05")).toEqual({ ok: false, reason: "not-ready" });
    expect(await answering(401, {}).course("cs101", "day", "2026-01-05")).toEqual({ ok: false, reason: "signed-out" });
    expect(await answering(400, { message: "?" }).course("cs101", "day", "2026-01-05")).toEqual({ ok: false, reason: "invalid" });
    expect(await answering(403, { message: "origin" }).student("cs101", "alice", "day", "2026-01-05")).toEqual({ ok: false, reason: "unavailable" });
    expect(await answering(200, "not json").course("cs101", "day", "2026-01-05")).toEqual({ ok: false, reason: "unavailable" });
    expect(await answering(200, { insights: { steps: [] } }).course("cs101", "day", "2026-01-05")).toEqual({ ok: false, reason: "unavailable" });
  });

  it("answers try again when the reader cannot be reached", async () => {
    const offline = readerApiInsightsDesk(createDataApi(async () => Promise.reject(new Error("offline"))));
    expect(await offline.course("cs101", "day", "2026-01-05")).toEqual({ ok: false, reason: "unavailable" });
  });
});
