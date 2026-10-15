/**
 * The learning, assistance, feedback and insights contexts beyond what their feature files drive:
 * the state table's corners, the queue's order and expiry, the notes fallback and the statistics.
 */
import { describe, expect, it } from "vitest";
import { openRequest, queueOrder, shouldExpire, transition, type HelpRequest } from "@tutors/domain/assistance";
import { anchorOf, audienceOf, isBroadcast } from "@tutors/domain/feedback";
import { cohortProfile, median, percentile, responseTimes, studentProgress } from "@tutors/domain/insights";
import { isStepRef, noteKey, notesToMarkdown, sameStep, stepKey, trimSlashes, type StepRef } from "@tutors/domain/learning";
import {
  acknowledgeHelp,
  broadcast,
  helpQueue,
  requestHelp,
  resolveHelp,
  saveNote,
  shareReflection,
  withMemoryFallback,
  answerHint,
  dayPeriod,
  studentProgress as progress,
  helpResponseTimes
} from "@tutors/application";
import {
  FixedClock,
  InMemoryAssistanceFeed,
  InMemoryAssistanceStore,
  InMemoryFeedbackStore,
  InMemoryInsightsRead,
  InMemoryNotesStore,
  RecordingPublisher
} from "@tutors/application/testing";

const ref: StepRef = { courseId: "cs101", labRoute: "/lab/cs101/lab-01", stepId: "02" };
const request = (id: string, kind: HelpRequest["kind"], at: string, learner = "alice"): HelpRequest => ({ ...openRequest(ref, { login: learner, name: null }, kind, at), id });

describe("learning", () => {
  it("compares and keys step references by their three parts", () => {
    expect(isStepRef(ref)).toBe(true);
    expect(isStepRef({ courseId: "cs101" })).toBe(false);
    expect(isStepRef(null)).toBe(false);
    expect(sameStep(ref, { ...ref })).toBe(true);
    expect(sameStep(ref, { ...ref, stepId: "03" })).toBe(false);
    expect(stepKey(ref)).toBe('["cs101","/lab/cs101/lab-01","02"]');
    expect(stepKey({ courseId: "a|b", labRoute: "c", stepId: "d" })).not.toBe(stepKey({ courseId: "a", labRoute: "b|c", stepId: "d" }));
    expect(noteKey(ref)).toBe("@notes/cs101/lab/cs101/lab-01/02");
    expect([trimSlashes("//a/b//"), trimSlashes("/a/", false), trimSlashes("///"), trimSlashes("/".repeat(100000) + "x")]).toEqual(["a/b", "/a", "", "x"]);
  });

  it("exports no empty note and falls back to routes when titles are missing", () => {
    const md = notesToMarkdown(
      "CS",
      [
        { ref, body: "kept", kind: "question", updatedAt: "2026-01-05T09:00:00.000Z" },
        { ref: { ...ref, stepId: "03" }, body: "  ", kind: "note", updatedAt: "2026-01-05T09:00:00.000Z" }
      ],
      (r) => `/x/${r.stepId}`
    );
    expect(md).toBe("# CS notes\n\n## /lab/cs101/lab-01\n\n### [02](/x/02)\n\n_question · 2026-01-05_\n\nkept\n");
  });

  it("forgets an emptied note and defaults an unknown kind to note", async () => {
    const notes = new InMemoryNotesStore();
    const clock = new FixedClock();
    expect((await saveNote({ notes, clock })({ ref, body: "x", kind: "bogus" as never }))?.kind).toBe("note");
    expect(await saveNote({ notes, clock })({ ref, body: "" })).toBeNull();
    expect(await notes.get(ref)).toBeNull();
  });

  it("keeps notes in memory once storage fails, and removes them there too", async () => {
    const inner = new InMemoryNotesStore();
    let warned = 0;
    const store = withMemoryFallback(inner, () => warned++);
    await store.put({ ref, body: "stored", kind: "note", updatedAt: "t" });
    inner.failing = true;
    expect((await store.forCourse("cs101")).map((n) => n.body)).toEqual([]);
    expect(store.inMemory).toBe(true);
    await store.put({ ref: { ...ref, stepId: "03" }, body: "memory", kind: "note", updatedAt: "t" });
    await store.remove(ref);
    expect(await store.get(ref)).toBeNull();
    expect((await store.forCourse("cs101")).map((n) => n.body)).toEqual(["memory"]);
    expect(warned).toBe(1);
  });

  it("still reads stored notes after a refused write", async () => {
    const inner = new InMemoryNotesStore();
    const store = withMemoryFallback(inner, () => {});
    await inner.put({ ref, body: "stored", kind: "note", updatedAt: "t" });
    const put = inner.put.bind(inner);
    inner.put = () => Promise.reject(new Error("quota"));
    await store.put({ ref: { ...ref, stepId: "03" }, body: "memory", kind: "note", updatedAt: "t" });
    inner.put = put;
    expect(store.inMemory).toBe(true);
    expect((await store.get(ref))?.body).toBe("stored");
    expect((await store.forCourse("cs101")).map((n) => n.body)).toEqual(["stored", "memory"]);
  });

  it("says a reflection was not shared when the notes cannot be read", async () => {
    const notes = new InMemoryNotesStore();
    notes.failing = true;
    expect(await shareReflection({ store: new InMemoryFeedbackStore(), notes, clock: new FixedClock() })(ref, "alice")).toEqual({ ok: false, reason: "unavailable" });
  });

  it("refuses to share a step with no note as a reflection", async () => {
    const result = await shareReflection({ store: new InMemoryFeedbackStore(), notes: new InMemoryNotesStore(), clock: new FixedClock() })(ref, "alice");
    expect(result).toEqual({ ok: false, reason: "no-note" });
  });
});

describe("assistance", () => {
  const lecturer = { login: "ellen", educator: true };
  const alice = { login: "alice", educator: false };

  it("answers a hint only on a hint request, with text, as an educator", () => {
    const hint = request("h1", "hint", "2026-01-05T09:00:00.000Z");
    expect(transition(hint, "answer-hint", alice, "t", "x")).toEqual({ ok: false, reason: "not-permitted" });
    expect(transition(hint, "answer-hint", lecturer, "t", " ")).toEqual({ ok: false, reason: "hint-required" });
    expect(transition(request("h2", "stuck", "t"), "answer-hint", lecturer, "t", "x")).toEqual({ ok: false, reason: "hint-required" });
    const answered = transition(hint, "answer-hint", lecturer, "2026-01-05T09:02:00.000Z", " Try a loop ");
    expect(answered.ok && answered.request).toMatchObject({ state: "resolved", hintText: "Try a loop", closed: { by: "ellen", reason: "hint" } });
  });

  it("lets only the system expire a request, and the student mark it solved", () => {
    const r = request("h1", "stuck", "2026-01-05T09:00:00.000Z");
    expect(transition(r, "expire", lecturer, "t").ok).toBe(false);
    expect(transition(r, "acknowledge", "system", "t").ok).toBe(false);
    expect(transition(r, "resolve", alice, "t").ok).toBe(true);
  });

  it("orders lecturer requests first, then the longest waiting", () => {
    const rows = [request("a", "stuck", "2026-01-05T09:00:00.000Z"), request("b", "lecturer", "2026-01-05T09:05:00.000Z"), request("c", "hint", "2026-01-05T08:59:00.000Z")];
    expect(rows.sort(queueOrder).map((r) => r.id)).toEqual(["b", "c", "a"]);
  });

  it("withdraws a request on read 4 hours after it was raised", async () => {
    const clock = new FixedClock(Date.parse("2026-01-05T09:00:00.000Z"));
    const store = new InMemoryAssistanceStore();
    const deps = { store, feed: new InMemoryAssistanceFeed(), clock, educatorsOf: async () => ["ellen"] };
    await requestHelp(deps)(ref, "stuck", { login: "alice", name: null });
    expect(shouldExpire(store.rows[0], clock.nowMs())).toBe(false);
    clock.advance(4 * 60 * 60 * 1000);
    expect(await helpQueue(deps)("cs101")).toEqual([]);
    expect(store.rows[0]).toMatchObject({ state: "withdrawn", closed: { by: "system", reason: "expired" } });
    expect(await resolveHelp(deps)(store.rows[0].id, lecturer)).toEqual({ ok: false, reason: "not-in-state-table" });
  });

  it("says a request was not sent when the store is unreachable, and refuses a bad kind", async () => {
    const store = new InMemoryAssistanceStore();
    const deps = { store, feed: new InMemoryAssistanceFeed(false), clock: new FixedClock(), educatorsOf: async () => ["ellen"] };
    expect(await requestHelp(deps)(ref, "chat" as never, { login: "alice", name: null })).toEqual({ ok: false, reason: "invalid" });
    store.unavailable = true;
    expect(await requestHelp(deps)(ref, "stuck", { login: "alice", name: null })).toEqual({ ok: false, reason: "unavailable" });
    expect(await resolveHelp(deps)("h1", lecturer)).toEqual({ ok: false, reason: "unavailable" });
    store.unavailable = false;
    expect(await resolveHelp(deps)("missing", lecturer)).toEqual({ ok: false, reason: "not-found" });
  });

  it("decides who is the educator from the course's list, not from the caller", async () => {
    const store = new InMemoryAssistanceStore();
    const deps = { store, feed: new InMemoryAssistanceFeed(), clock: new FixedClock(), educatorsOf: async () => ["ellen"] };
    const asked = await requestHelp(deps)(ref, "stuck", { login: "alice", name: null });
    if (!asked.ok) throw new Error(asked.reason);
    expect(await acknowledgeHelp(deps)(asked.request.id, { login: "mallory", educator: true } as never)).toEqual({ ok: false, reason: "not-permitted" });
    expect((await acknowledgeHelp(deps)(asked.request.id, { login: "ellen" })).ok).toBe(true);
    expect(await acknowledgeHelp({ ...deps, educatorsOf: () => Promise.reject(new Error("down")) })(asked.request.id, { login: "ellen" })).toEqual({ ok: false, reason: "unavailable" });
  });

  it("refuses a request whose step reference is incomplete", async () => {
    const deps = { store: new InMemoryAssistanceStore(), feed: new InMemoryAssistanceFeed(), clock: new FixedClock() };
    expect(await requestHelp(deps)({ ...ref, stepId: " " }, "stuck", { login: "alice", name: null })).toEqual({ ok: false, reason: "invalid" });
  });

  it("tells watchers of an expiry, and keeps a request live when its expiry was not stored", async () => {
    const clock = new FixedClock(Date.parse("2026-01-05T09:00:00.000Z"));
    const store = new InMemoryAssistanceStore();
    const feed = new InMemoryAssistanceFeed();
    const deps = { store, feed, clock, educatorsOf: async () => ["ellen"] };
    await requestHelp(deps)(ref, "stuck", { login: "alice", name: null });
    clock.advance(4 * 60 * 60 * 1000);
    const replace = store.replace.bind(store);
    store.replace = async () => false;
    expect((await helpQueue(deps)("cs101")).map((e) => e.request.learnerId)).toEqual(["alice"]);
    store.replace = replace;
    feed.published.length = 0;
    expect(await helpQueue(deps)("cs101")).toEqual([]);
    expect(feed.published).toMatchObject([{ type: "help-request", request: { state: "withdrawn" } }]);
  });

  it("publishes help-answered when a lecturer answers a hint", async () => {
    const publisher = new RecordingPublisher();
    const store = new InMemoryAssistanceStore();
    const deps = { store, feed: new InMemoryAssistanceFeed(), clock: new FixedClock(), educatorsOf: async () => ["ellen"], publish: (e: never) => publisher.publish(e) };
    const asked = await requestHelp(deps)(ref, "hint", { login: "alice", name: null });
    if (!asked.ok) throw new Error(asked.reason);
    expect((await answerHint(deps)(asked.request.id, lecturer, "Use a map")).ok).toBe(true);
    expect(publisher.events.map((e) => e.type)).toEqual(["help-requested", "help-answered"]);
  });
});

describe("feedback", () => {
  it("names one anchor and one audience", () => {
    expect(anchorOf({ ref, snippetId: " g1 " })).toEqual({ kind: "snippet", ref, snippetId: "g1" });
    expect(audienceOf({})).toBe("no-audience");
    expect(isBroadcast({ audience: { kind: "everyone" } })).toBe(true);
  });

  it("broadcasts to everyone on the step and tells the watchers", async () => {
    const feed = new InMemoryAssistanceFeed();
    const result = await broadcast({ store: new InMemoryFeedbackStore(), clock: new FixedClock(), educatorsOf: async () => ["ellen"], feed })(ref, "Await it.", { login: "ellen" });
    expect(result.ok).toBe(true);
    expect(feed.published.map((c) => c.type)).toEqual(["annotation"]);
  });

  it("answers 503 when the educator list cannot be read, and refuses an empty body", async () => {
    const deps = { store: new InMemoryFeedbackStore(), clock: new FixedClock() };
    expect(await broadcast({ ...deps, educatorsOf: () => Promise.reject(new Error("down")), feed: new InMemoryAssistanceFeed() })(ref, "x", { login: "ellen" })).toMatchObject({
      status: 503
    });
    expect(await broadcast({ ...deps, educatorsOf: async () => ["ellen"], feed: new InMemoryAssistanceFeed() })(ref, " ", { login: "ellen" })).toMatchObject({ status: 400 });
  });
});

describe("insights", () => {
  it("computes nearest-rank percentiles and withholds them for a small cohort", () => {
    expect(percentile([], 90)).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(cohortProfile("cs101", ["a", "b", "a"])).toEqual({ courseId: "cs101", students: 2, percentilesShown: false });
  });

  it("reports response times per kind and a student's progress", async () => {
    const acked: HelpRequest = {
      ...request("h1", "lecturer", "2026-01-05T09:00:00.000Z"),
      state: "resolved",
      acknowledged: { by: "ellen", at: "2026-01-05T09:01:00.000Z" },
      closed: { by: "ellen", at: "2026-01-05T09:04:00.000Z", reason: "resolved" }
    };
    const times = responseTimes([acked]);
    expect(times.lecturer).toEqual({ acknowledge: { median: 60, p90: 60, count: 1 }, resolve: { median: 240, p90: 240, count: 1 } });
    expect(times.stuck.acknowledge.count).toBe(0);
    const read = new InMemoryInsightsRead([acked], [], [{ id: "r1", ref, learnerId: "alice", body: "b", kind: "note", sharedAt: "2026-01-05T10:00:00.000Z" }]);
    const period = dayPeriod("2026-01-05");
    expect(period).toEqual({ from: "2026-01-05T00:00:00.000Z", to: "2026-01-06T00:00:00.000Z" });
    expect(await progress({ insights: read })("cs101", "alice", period)).toEqual({
      learnerId: "alice",
      requestsRaised: 1,
      hintsRead: 0,
      annotationsReceived: 0,
      reflectionsShared: 1
    });
    expect((await helpResponseTimes({ insights: read })("cs101", period)).lecturer.resolve.count).toBe(1);
    expect(studentProgress("bob", [acked], [], []).requestsRaised).toBe(0);
    const toAll = { id: "a1", anchor: { kind: "step" as const, ref }, audience: { kind: "everyone" as const }, body: "b", authorId: "ellen", createdAt: "t", revokedAt: null };
    const elsewhere = { ...toAll, id: "a2", anchor: { kind: "step" as const, ref: { ...ref, stepId: "09" } } };
    expect(studentProgress(acked.learnerId, [acked], [toAll, elsewhere], []).annotationsReceived).toBe(1);
    expect(studentProgress("bob", [acked], [toAll], []).annotationsReceived).toBe(0);
  });
});
