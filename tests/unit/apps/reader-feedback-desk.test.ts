/**
 * The browser's FeedbackDesk over the reader's /api/feedback (readerApiFeedbackDesk): the feedback
 * desk contract run through the data API client against the reader's own route handlers, each call
 * made as the person signed in, over the in-memory store, feed and notices; what each answer the
 * reader can give becomes; and the parsing of what a browser posts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { feedbackDeskContract, InMemoryAssistanceFeed, InMemoryCourseNotices, InMemoryFeedbackStore } from "@tutors/application/testing";
import { createDataApi, readerApiFeedbackDesk } from "@tutors/data-api";

const server = vi.hoisted(() => ({ data: null as unknown, feed: null as unknown, notices: null as unknown, educators: ["ellen"] as string[] | null }));
vi.mock("../../../apps/reader/src/lib/server/api/adapters.ts", () => ({
  readerServer: () => ({ data: server.data, realtime: { assistance: server.feed } })
}));
vi.mock("../../../apps/reader/src/lib/server/snippets.ts", () => ({
  educatorsOf: async () => {
    if (!server.educators) throw new Error("course unreachable");
    return server.educators;
  },
  serverNotices: { post: (n: unknown) => (server.notices as InMemoryCourseNotices).post(n as never), watch: () => () => {} }
}));
vi.mock("../../../apps/reader/src/lib/server/api/access.ts", () => ({ allowedOrigins: () => [] }));
vi.mock("@tutors/svelte-state/adapters", () => ({ adapters: () => ({ anonymous: false }) }));

import { GET, OPTIONS, POST } from "../../../apps/reader/src/routes/api/feedback/+server.ts";
import { GET as MINE } from "../../../apps/reader/src/routes/api/feedback/mine/+server.ts";
import { parseFeedbackPost } from "../../../apps/reader/src/lib/server/feedback.ts";

const ORIGIN = "https://reader.test";

function readerAs(login: string | null) {
  return async (input: string, init?: RequestInit) => {
    const url = new URL(input, ORIGIN);
    const request = new Request(url, init);
    const event = { request, url, locals: { actor: login ? { login, name: login.toUpperCase(), subject: `github:${login}` } : null }, fetch } as never;
    if (url.pathname === "/api/feedback/mine") return MINE(event);
    return request.method === "POST" ? POST(event) : GET(event);
  };
}
const deskAs = (login: string | null) => readerApiFeedbackDesk(createDataApi(readerAs(login)));
const ref = { courseId: "cs101", labRoute: "/lab/cs101/lab-01", stepId: "02" };

function fresh() {
  server.data = { feedback: new InMemoryFeedbackStore() };
  server.feed = new InMemoryAssistanceFeed();
  server.notices = new InMemoryCourseNotices();
  server.educators = ["ellen"];
}

beforeEach(fresh);
afterEach(() => vi.restoreAllMocks());

describe("FeedbackDesk: the reader's /api/feedback", () => {
  for (const c of feedbackDeskContract(() => {
    fresh();
    return { student: deskAs("alice"), other: deskAs("bob"), educator: deskAs("ellen"), visitor: deskAs(null) };
  })) {
    it(c.name, c.run);
  }
});

describe("POST /api/feedback", () => {
  it("toasts a broadcast to the course and tells the help queue's watchers", async () => {
    const heard: unknown[] = [];
    (server.feed as InMemoryAssistanceFeed).watch("cs101", (change) => heard.push(change.type));
    const posted = await deskAs("ellen").broadcast(ref, "Await   the\nfetch.", "Fetching data");
    expect(posted.ok).toBe(true);
    expect(heard).toEqual(["annotation"]);
    expect((server.notices as InMemoryCourseNotices).posted).toEqual([
      expect.objectContaining({
        type: "course:broadcast",
        courseId: "cs101",
        title: "Fetching data",
        description: "Await the fetch.",
        actionUrl: "/lab/cs101/lab-01/02",
        senderName: "ELLEN"
      })
    ]);
  });

  it("treats an annotation for everyone on the step as a broadcast", async () => {
    const posted = await deskAs("ellen").annotate({ ref }, { everyone: true }, "For everyone");
    expect(posted.ok && posted.annotation.audience).toEqual({ kind: "everyone" });
    expect((server.notices as InMemoryCourseNotices).posted).toHaveLength(1);
  });

  it("answers 503 when the server keeps no feedback or the store fails, and 401 to a visitor", async () => {
    server.data = { feedback: null };
    expect(await deskAs("ellen").broadcast(ref, "x")).toEqual({ ok: false, reason: "not-kept" });
    await expect(deskAs("alice").step(ref)).rejects.toThrow();
    await expect(deskAs("alice").received("cs101")).rejects.toThrow();
    fresh();
    (server.data as { feedback: InMemoryFeedbackStore }).feedback.unavailable = true;
    expect(await deskAs("ellen").broadcast(ref, "x")).toEqual({ ok: false, reason: "unavailable" });
    expect(await deskAs("alice").reflect({ ref, body: "x", kind: "note", updatedAt: "" })).toEqual({ ok: false, reason: "unavailable" });
    await expect(deskAs("alice").step(ref)).rejects.toThrow();
    await expect(deskAs("alice").received("cs101")).rejects.toThrow();
    expect(await deskAs(null).revoke("a1")).toEqual({ ok: false, reason: "signed-out" });
    expect(await deskAs(null).received("cs101")).toEqual([]);
  });

  it("answers 503 when the course's educators cannot be read", async () => {
    server.educators = null;
    expect(await deskAs("ellen").broadcast(ref, "x")).toEqual({ ok: false, reason: "unavailable" });
    expect((await deskAs("ellen").step(ref)).history).toBeNull();
  });

  it("refuses a step outside the course's labs and a malformed post", async () => {
    expect(await deskAs("ellen").broadcast({ ...ref, labRoute: "/lab/cs102/lab-01" }, "x")).toEqual({ ok: false, reason: "invalid" });
    expect(parseFeedbackPost({ action: "nope" })).toMatch(/action/);
    expect(parseFeedbackPost({ action: "revoke" })).toMatch(/id/);
    expect(parseFeedbackPost({ action: "annotate", ...ref, body: 7 })).toMatch(/body/);
    expect(parseFeedbackPost({ action: "annotate", ...ref, body: "x", learnerId: 7 })).toMatch(/learnerId/);
    expect(parseFeedbackPost({ action: "annotate", ...ref, body: "x", everyone: "yes" })).toMatch(/everyone/);
    expect(parseFeedbackPost({ action: "broadcast", ...ref, body: "x", stepTitle: 7 })).toMatch(/stepTitle/);
    expect(parseFeedbackPost({ action: "reflect", ...ref, body: "x", kind: "poem" })).toMatch(/kind/);
    expect(parseFeedbackPost({ action: "annotate", courseId: "cs101", body: "x" })).toMatch(/required/);
    expect(parseFeedbackPost({ action: "annotate", ...ref, body: "x".repeat(4001) })).toMatch(/4000/);
  });

  it("answers the preflight for a listed origin only", async () => {
    const event = (origin: string) =>
      ({ request: new Request(`${ORIGIN}/api/feedback`, { method: "OPTIONS", headers: { origin } }), url: new URL(`${ORIGIN}/api/feedback`) }) as never;
    expect((await OPTIONS(event("https://evil.test"))).status).toBe(403);
    expect((await OPTIONS(event(ORIGIN))).status).toBe(204);
  });
});

describe("readerApiFeedbackDesk answers", () => {
  const answering = (status: number, body: unknown) => readerApiFeedbackDesk(createDataApi(async () => new Response(JSON.stringify(body), { status })));

  it("names the refusal the reader gave, and what a status with none means", async () => {
    expect(await answering(403, { reason: "forbidden" }).revoke("a1")).toEqual({ ok: false, reason: "forbidden" });
    expect(await answering(400, { reason: "invalid", detail: "two-anchors" }).annotate({ ref }, { learnerId: "alice" }, "x")).toEqual({
      ok: false,
      reason: "invalid",
      detail: "two-anchors"
    });
    expect(await answering(503, { message: "not kept" }).revoke("a1")).toEqual({ ok: false, reason: "not-kept" });
    expect(await answering(400, { message: "?" }).revoke("a1")).toEqual({ ok: false, reason: "invalid" });
    expect(await answering(403, { message: "origin" }).revoke("a1")).toEqual({ ok: false, reason: "unavailable" });
  });

  it("answers try again when the reader cannot be reached", async () => {
    const offline = readerApiFeedbackDesk(createDataApi(async () => Promise.reject(new Error("offline"))));
    expect(await offline.revoke("a1")).toEqual({ ok: false, reason: "unavailable" });
    await expect(offline.step(ref)).rejects.toThrow();
  });
});
