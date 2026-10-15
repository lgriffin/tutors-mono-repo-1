/**
 * The browser's HelpDesk over the reader's /api/assistance (readerApiHelpDesk): the help desk
 * contract run through the data API client against the reader's own route handlers, each call made
 * as the person signed in, over the in-memory store and feed; and what each answer the reader can
 * give becomes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { helpDeskContract, InMemoryAssistanceFeed, InMemoryAssistanceStore } from "@tutors/application/testing";
import { createDataApi, readerApiHelpDesk } from "@tutors/data-api";

const server = vi.hoisted(() => ({ data: null as unknown, feed: null as unknown, educators: ["ellen"] }));
vi.mock("../../../apps/reader/src/lib/server/api/adapters.ts", () => ({
  readerServer: () => ({ data: server.data, realtime: { assistance: server.feed } })
}));
vi.mock("../../../apps/reader/src/lib/server/snippets.ts", () => ({ educatorsOf: async () => server.educators }));
vi.mock("../../../apps/reader/src/lib/server/api/access.ts", () => ({ allowedOrigins: () => [] }));
vi.mock("@tutors/svelte-state/adapters", () => ({ adapters: () => ({ anonymous: false }) }));

import { GET, POST } from "../../../apps/reader/src/routes/api/assistance/+server.ts";
import { GET as MINE } from "../../../apps/reader/src/routes/api/assistance/mine/+server.ts";

const ORIGIN = "https://reader.test";

/** A fetch that hands each call to the reader's route, as `login` (or nobody). */
function readerAs(login: string | null) {
  return async (input: string, init?: RequestInit) => {
    const url = new URL(input, ORIGIN);
    const request = new Request(url, init);
    const event = { request, url, locals: { actor: login ? { login, name: login.toUpperCase(), subject: `github:${login}` } : null }, fetch } as never;
    if (url.pathname === "/api/assistance/mine") return MINE(event);
    return request.method === "POST" ? POST(event) : GET(event);
  };
}
const deskAs = (login: string | null) => readerApiHelpDesk(createDataApi(readerAs(login)));

beforeEach(() => {
  server.data = { assistance: new InMemoryAssistanceStore() };
  server.feed = new InMemoryAssistanceFeed();
});
afterEach(() => vi.restoreAllMocks());

describe("HelpDesk: the reader's /api/assistance", () => {
  for (const c of helpDeskContract(() => {
    server.data = { assistance: new InMemoryAssistanceStore() };
    return { student: deskAs("alice"), educator: deskAs("ellen"), visitor: deskAs(null) };
  })) {
    it(c.name, c.run);
  }
});

describe("readerApiHelpDesk answers", () => {
  const answering = (status: number, body: unknown) => readerApiHelpDesk(createDataApi(async () => new Response(JSON.stringify(body), { status })));
  const ref = { courseId: "cs101", labRoute: "/lab/cs101/lab-01", stepId: "02" };

  it("names the refusal the reader gave, and what a status with none means", async () => {
    expect(await answering(409, { reason: "conflict" }).ask(ref, "stuck")).toEqual({ ok: false, reason: "conflict" });
    expect(await answering(401, { message: "Sign in" }).ask(ref, "stuck")).toEqual({ ok: false, reason: "signed-out" });
    expect(await answering(503, { message: "not kept" }).ask(ref, "stuck")).toEqual({ ok: false, reason: "not-kept" });
    expect(await answering(503, { reason: "unavailable" }).ask(ref, "stuck")).toEqual({ ok: false, reason: "unavailable" });
    expect(await answering(400, { message: "kind is one of" }).ask(ref, "stuck")).toEqual({ ok: false, reason: "invalid" });
    expect(await answering(403, { message: "origin" }).ask(ref, "stuck")).toEqual({ ok: false, reason: "unavailable" });
  });

  it("answers try again when the reader cannot be reached, and rejects a read it could not make", async () => {
    const offline = readerApiHelpDesk(createDataApi(async () => Promise.reject(new Error("offline"))));
    expect(await offline.act("h1", "withdraw")).toEqual({ ok: false, reason: "unavailable" });
    await expect(offline.mine("cs101")).rejects.toThrow();
    await expect(offline.queue("cs101")).rejects.toThrow();
  });
});

describe("POST /api/assistance rate", () => {
  it("is read as true or false only", async () => {
    const { parseHelpPost } = await import("../../../apps/reader/src/lib/server/assistance.ts");
    expect(parseHelpPost({ action: "rate", id: "h1", helped: false })).toEqual({ action: "rate", id: "h1", helped: false });
    expect(parseHelpPost({ action: "rate", id: "h1", helped: "yes" })).toMatch(/helped/);
  });
});
