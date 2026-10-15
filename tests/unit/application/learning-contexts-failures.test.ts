/**
 * The learning, assistance, feedback and insights use cases when what is under them refuses or
 * fails: a store that throws or loses a race, a feed that throws, a request that is past its
 * expiry when a lecturer acts on it.
 */
import { describe, expect, it } from "vitest";
import { openRequest, type HelpRequest } from "@tutors/domain/assistance";
import { isRevoked, type Annotation } from "@tutors/domain/feedback";
import { stepDiagnostics } from "@tutors/domain/insights";
import { isEvidenceKind, type StepRef } from "@tutors/domain/learning";
import { annotate, broadcast, recordEvidence, requestHelp, resolveHelp, saveNote, type AssistanceDeps } from "@tutors/application";
import { FixedClock, InMemoryAssistanceFeed, InMemoryAssistanceStore, InMemoryFeedbackStore, InMemoryNotesStore, RecordingPublisher } from "@tutors/application/testing";

const ref: StepRef = { courseId: "cs101", labRoute: "/lab/cs101/lab-01", stepId: "02" };
const alice = { login: "alice", name: null };

/** A feed whose every publish throws: the change it reports stands regardless. */
class ThrowingFeed extends InMemoryAssistanceFeed {
  override async publish(): Promise<boolean> {
    throw new Error("feed down");
  }
}

function deps(over: Partial<AssistanceDeps> = {}): AssistanceDeps & { store: InMemoryAssistanceStore } {
  return {
    store: new InMemoryAssistanceStore(),
    feed: new InMemoryAssistanceFeed(),
    clock: new FixedClock(Date.parse("2026-01-05T09:00:00.000Z")),
    educatorsOf: async () => ["ellen"],
    ...over
  } as AssistanceDeps & {
    store: InMemoryAssistanceStore;
  };
}

describe("assistance when the store or feed fails", () => {
  it("keeps a request and its expiry when the feed throws", async () => {
    const d = deps({ feed: new ThrowingFeed() });
    const asked = await requestHelp(d)(ref, "stuck", alice);
    expect(asked.ok).toBe(true);
    expect((await resolveHelp(d)(d.store.rows[0].id, { login: "ellen" })).ok).toBe(true);
    await requestHelp(d)(ref, "hint", alice);
    (d.clock as FixedClock).advance(4 * 60 * 60 * 1000);
    expect(await requestHelp(d)(ref, "stuck", alice)).toMatchObject({ ok: true });
    expect(d.store.rows[1]).toMatchObject({ state: "withdrawn", closed: { reason: "expired" } });
  });

  it("keeps a request live when storing its expiry throws", async () => {
    const d = deps();
    await requestHelp(d)(ref, "stuck", alice);
    (d.clock as FixedClock).advance(4 * 60 * 60 * 1000);
    d.store.replace = () => Promise.reject(new Error("down"));
    d.store.open = () => Promise.reject(new Error("must not open a second request"));
    expect(await requestHelp(d)(ref, "hint", alice)).toEqual({ ok: false, reason: "unavailable" });
  });

  it("says conflict when asking again loses a race", async () => {
    const d = deps();
    await requestHelp(d)(ref, "stuck", alice);
    d.store.replace = async () => false;
    expect(await requestHelp(d)(ref, "hint", alice)).toEqual({ ok: false, reason: "conflict" });
  });

  it("withdraws a request a lecturer acts on after 4 hours, and refuses the action", async () => {
    const d = deps();
    await requestHelp(d)(ref, "stuck", alice);
    (d.clock as FixedClock).advance(4 * 60 * 60 * 1000);
    expect(await resolveHelp(d)(d.store.rows[0].id, { login: "ellen" })).toEqual({ ok: false, reason: "not-in-state-table" });
    expect(d.store.rows[0]).toMatchObject({ state: "withdrawn", closed: { by: "system", reason: "expired" } });
  });

  it("says unavailable or conflict when a lecturer's change is not stored", async () => {
    const d = deps();
    await requestHelp(d)(ref, "stuck", alice);
    const id = d.store.rows[0].id;
    d.store.replace = () => Promise.reject(new Error("down"));
    expect(await resolveHelp(d)(id, { login: "ellen" })).toEqual({ ok: false, reason: "unavailable" });
    d.store.replace = async () => false;
    expect(await resolveHelp(d)(id, { login: "ellen" })).toEqual({ ok: false, reason: "conflict" });
  });

  it("does not publish help-answered when the student marks their own request solved", async () => {
    const publisher = new RecordingPublisher();
    const d = deps({ publish: (e) => publisher.publish(e) });
    await requestHelp(d)(ref, "stuck", alice);
    expect((await resolveHelp(d)(d.store.rows[0].id, { login: "alice" })).ok).toBe(true);
    expect(publisher.events.map((e) => e.type)).toEqual(["help-requested"]);
  });
});

describe("feedback when the store or feed fails", () => {
  const feedbackDeps = () => ({ store: new InMemoryFeedbackStore(), clock: new FixedClock(), educatorsOf: async () => ["ellen"] });

  it("says unavailable when the annotation is not stored", async () => {
    const d = feedbackDeps();
    d.store.annotate = () => Promise.reject(new Error("down"));
    expect(await annotate(d)({ anchor: { ref }, audience: { learnerId: "alice" }, body: "Look again" }, { login: "ellen" })).toEqual({
      ok: false,
      reason: "unavailable",
      status: 503
    });
  });

  it("keeps a broadcast when the feed throws", async () => {
    const result = await broadcast({ ...feedbackDeps(), feed: new ThrowingFeed() })(ref, "Await it.", { login: "ellen" });
    expect(result.ok).toBe(true);
  });
});

describe("learning and insights edges", () => {
  it("knows the evidence kinds, publishes evidence only for a signed-in learner, and keeps a lab title on a note", async () => {
    expect([isEvidenceKind("snippet"), isEvidenceKind("visit-the-moon"), isEvidenceKind(3)]).toEqual([true, false, false]);
    const publisher = new RecordingPublisher();
    const evidence = { kind: "snippet" as const, ref, id: "s1", at: "2026-01-05T09:00:00.000Z" };
    await recordEvidence({ publish: (e) => publisher.publish(e) })("", evidence);
    await recordEvidence({ publish: (e) => publisher.publish(e) })("alice", evidence);
    expect(publisher.events).toEqual([{ type: "evidence-recorded", learnerId: "alice", evidence }]);
    const note = await saveNote({ notes: new InMemoryNotesStore(), clock: new FixedClock() })({ ref, body: "x", labTitle: "Lab One" });
    expect(note?.labTitle).toBe("Lab One");
  });

  it("orders the day's diagnostics by step, with numeric step ids, and tells a revoked annotation", () => {
    const at = "2026-01-05T09:00:00.000Z";
    const asked = (stepId: string): HelpRequest => ({ ...openRequest({ ...ref, stepId }, alice, "stuck", at), id: `h${stepId}` });
    const note: Annotation = {
      id: "a1",
      anchor: { kind: "step", ref: { ...ref, stepId: "3" } },
      audience: { kind: "everyone" },
      body: "b",
      authorId: "ellen",
      createdAt: at,
      revokedAt: null
    };
    const other: Annotation = { ...note, id: "a2", createdAt: "2026-01-06T09:00:00.000Z" };
    expect(stepDiagnostics("2026-01-05", [asked("10"), asked("2"), { ...asked("7"), requestedAt: "2026-01-04T09:00:00.000Z" }], [note, other]).map((d) => d.ref.stepId)).toEqual([
      "2",
      "3",
      "10"
    ]);
    expect([isRevoked(note), isRevoked({ ...note, revokedAt: at })]).toEqual([false, true]);
  });
});
