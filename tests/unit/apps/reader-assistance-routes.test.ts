/**
 * The reader's /api/assistance routes at their edges: what a malformed post, a server that keeps no
 * help requests, an origin the reader does not list and a failing store answer. The Rules the routes
 * keep (features/shared/help-request-server.feature) drive them over Postgres; these cases are the
 * refusals around them, over the in-memory adapters.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryAssistanceFeed, InMemoryAssistanceStore } from "@tutors/application/testing";

const server = vi.hoisted(() => ({ data: null as unknown, feed: null as unknown, anonymous: false, educators: ["ellen"] }));
vi.mock("../../../apps/reader/src/lib/server/api/adapters.ts", () => ({
  readerServer: () => ({ data: server.data, realtime: { assistance: server.feed } })
}));
vi.mock("../../../apps/reader/src/lib/server/snippets.ts", () => ({ educatorsOf: async () => server.educators }));
vi.mock("../../../apps/reader/src/lib/server/api/access.ts", () => ({ allowedOrigins: () => ["https://live.test"] }));
vi.mock("@tutors/svelte-state/adapters", () => ({ adapters: () => ({ anonymous: server.anonymous }) }));

import { GET, OPTIONS, POST } from "../../../apps/reader/src/routes/api/assistance/+server.ts";
import { GET as MINE } from "../../../apps/reader/src/routes/api/assistance/mine/+server.ts";
import { HELP_REFUSALS, MAX_HINT_LENGTH, parseHelpPost } from "../../../apps/reader/src/lib/server/assistance.ts";

const ORIGIN = "https://reader.test";
const actor = (login: string) => ({ login, name: login.toUpperCase(), subject: `github:${login}` });
const post = (body: unknown, login: string | null = "alice", origin?: string) =>
  POST({
    request: new Request(`${ORIGIN}/api/assistance`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
      body: JSON.stringify(body)
    }),
    url: new URL(`${ORIGIN}/api/assistance`),
    locals: { actor: login ? actor(login) : null },
    fetch
  } as never);
const get = (handler: typeof GET, path: string, login: string | null = "ellen", origin?: string) =>
  handler({
    request: new Request(`${ORIGIN}${path}`, { headers: origin ? { origin } : {} }),
    url: new URL(`${ORIGIN}${path}`),
    locals: { actor: login ? actor(login) : null },
    fetch
  } as never);
const ask = { action: "request", courseId: "cs101", labRoute: "/lab/cs101/lab-01", stepId: "02", kind: "stuck" };

let store: InMemoryAssistanceStore;
beforeEach(() => {
  store = new InMemoryAssistanceStore();
  server.data = { assistance: store };
  server.feed = new InMemoryAssistanceFeed();
  server.anonymous = false;
  server.educators = ["ellen"];
});
afterEach(() => vi.restoreAllMocks());

describe("parseHelpPost", () => {
  it("reads a request on a step and each action on an id", () => {
    expect(parseHelpPost(ask)).toEqual({ action: "request", ref: { courseId: "cs101", labRoute: "/lab/cs101/lab-01", stepId: "02" }, kind: "stuck" });
    for (const action of ["acknowledge", "resolve", "withdraw"]) expect(parseHelpPost({ action, id: " h1 " })).toEqual({ action, id: "h1" });
    expect(parseHelpPost({ action: "answer-hint", id: "h1", hintText: "Look at line 3" })).toEqual({ action: "answer-hint", id: "h1", hintText: "Look at line 3" });
    expect(parseHelpPost({ action: "answer-hint", id: "h1" })).toEqual({ action: "answer-hint", id: "h1", hintText: "" });
  });

  it("says what is wrong with a malformed post", () => {
    expect(parseHelpPost({ ...ask, stepId: " " })).toMatch(/stepId/);
    expect(parseHelpPost({ ...ask, courseId: "x".repeat(201) })).toMatch(/courseId/);
    expect(parseHelpPost({ ...ask, kind: 3 })).toMatch(/kind/);
    expect(parseHelpPost({ ...ask, labRoute: "/lab/cs102/lab-01" })).toMatch(/lab of the course/);
    expect(parseHelpPost({ ...ask, labRoute: "/lab/cs1010/lab-01" })).toMatch(/lab of the course/);
    expect(parseHelpPost({ action: "resolve" })).toMatch(/id/);
    expect(parseHelpPost({ action: "answer-hint", id: "h1", hintText: "x".repeat(MAX_HINT_LENGTH + 1) })).toMatch(/at most/);
    expect(parseHelpPost({ action: "delete", id: "h1" })).toMatch(/action is one of/);
  });

  it("answers every refusal with a status", () => {
    expect(Object.values(HELP_REFUSALS).map((r) => r.status)).toEqual([400, 400, 403, 404, 409, 409, 503]);
  });
});

describe("POST /api/assistance", () => {
  it("opens a request as the signed-in student, and lets them withdraw it", async () => {
    const opened = await post(ask);
    expect(opened.status).toBe(201);
    const { request } = (await opened.json()) as { request: { id: string; learnerId: string } };
    expect(request.learnerId).toBe("alice");
    expect((await post({ action: "withdraw", id: request.id })).status).toBe(200);
    expect(store.rows[0].state).toBe("withdrawn");
  });

  it("lets the educator answer a hint and resolve", async () => {
    const { request } = (await (await post({ ...ask, kind: "hint" })).json()) as { request: { id: string } };
    expect((await post({ action: "answer-hint", id: request.id, hintText: "" }, "ellen")).status).toBe(400);
    expect((await post({ action: "answer-hint", id: request.id, hintText: "Check the bound" }, "ellen")).status).toBe(200);
    expect((await post({ action: "resolve", id: request.id }, "ellen")).status).toBe(409);
  });

  it("refuses an unknown kind, an unknown request and a malformed post", async () => {
    expect((await post({ ...ask, kind: "panic" })).status).toBe(400);
    expect((await post({ action: "acknowledge", id: "nope" }, "ellen")).status).toBe(404);
    expect((await post({ action: "acknowledge" })).status).toBe(400);
  });

  it("answers 503 when the store fails, and when the server keeps no help requests", async () => {
    store.unavailable = true;
    expect((await post(ask)).status).toBe(503);
    server.data = null;
    expect((await post(ask)).status).toBe(503);
  });

  it("refuses anonymous mode and an origin the reader does not list", async () => {
    expect((await post(ask, "alice", "https://evil.test")).status).toBe(403);
    server.anonymous = true;
    expect((await post(ask)).status).toBe(401);
  });

  it("answers Tutors Live with the session's CORS headers", async () => {
    const answer = await post(ask, "alice", "https://live.test");
    expect(answer.headers.get("access-control-allow-origin")).toBe("https://live.test");
    expect(answer.headers.get("access-control-allow-credentials")).toBe("true");
  });
});

describe("GET /api/assistance", () => {
  it("answers the queue to the educator, and refuses everyone else", async () => {
    await post(ask);
    const queue = (await (await get(GET, "/api/assistance?courseId=cs101")).json()) as { queue: unknown[] };
    expect(queue.queue).toHaveLength(1);
    expect((await get(GET, "/api/assistance?courseId=cs101", "alice")).status).toBe(403);
    expect((await get(GET, "/api/assistance?courseId=cs101", null)).status).toBe(401);
    expect((await get(GET, "/api/assistance?courseId=cs101", "ellen", "https://evil.test")).status).toBe(403);
  });

  it("needs a course, a store that answers and one it keeps", async () => {
    expect((await get(GET, "/api/assistance")).status).toBe(400);
    store.unavailable = true;
    expect((await get(GET, "/api/assistance?courseId=cs101")).status).toBe(503);
    server.data = null;
    expect((await get(GET, "/api/assistance?courseId=cs101")).status).toBe(503);
  });
});

describe("GET /api/assistance/mine", () => {
  it("answers the student's own request, and refuses a visitor", async () => {
    await post(ask);
    const mine = (await (await get(MINE, "/api/assistance/mine?courseId=cs101", "alice")).json()) as { request: { learnerId: string } | null };
    expect(mine.request?.learnerId).toBe("alice");
    expect((await get(MINE, "/api/assistance/mine?courseId=cs101", null)).status).toBe(401);
    expect((await get(MINE, "/api/assistance/mine", "alice")).status).toBe(400);
  });

  it("answers 503 when the store fails, and when the server keeps no help requests", async () => {
    store.unavailable = true;
    expect((await get(MINE, "/api/assistance/mine?courseId=cs101", "alice")).status).toBe(503);
    server.data = null;
    expect((await get(MINE, "/api/assistance/mine?courseId=cs101", "alice")).status).toBe(503);
  });
});

describe("OPTIONS /api/assistance", () => {
  it("lets Tutors Live post with the session, and nobody else", async () => {
    const preflight = (origin: string) =>
      OPTIONS({ request: new Request(`${ORIGIN}/api/assistance`, { method: "OPTIONS", headers: { origin } }), url: new URL(`${ORIGIN}/api/assistance`) } as never);
    const allowed = await preflight("https://live.test");
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-methods")).toBe("GET, POST");
    expect(allowed.headers.get("access-control-allow-credentials")).toBe("true");
    expect((await preflight("https://evil.test")).status).toBe(403);
  });
});
