// @vitest-environment happy-dom
/**
 * Lecturer feedback's state in the reader (feedbackService) and the explanation offer in Tutors
 * Live's queue (helpQueueService), over the in-memory desks, which run the real use cases. The BDD
 * features cover what a student and a lecturer see; these cover the edges: refusals, failed reads,
 * a hidden tab, moving between steps, replies to reflections and a broadcast heard on the stream.
 */
import "../../bdd/support/svelte-runes-shim.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { feedbackService, FEEDBACK_POLL_MS } from "../../../packages/adapters/driving/svelte-state/src/feedback/step.svelte.ts";
import { helpQueueService } from "../../../packages/adapters/driving/svelte-state/src/assistance/queue.svelte.ts";
import { anonymousAdapters, configureAdapters } from "../../../packages/adapters/driving/svelte-state/src/adapters.ts";
import { FixedClock, InMemoryFeedbackDesk, InMemoryHelpDesk, PassThroughRenderer, SignedOutFeedbackDesk } from "../../../packages/application/src/testing/index.ts";
import type { FeedbackDesk } from "../../../packages/application/src/ports/index.ts";
import type { StepRef } from "../../../packages/domain/src/learning/index.ts";

const REF: StepRef = { courseId: "cs101", labRoute: "/lab/cs101/lab-01", stepId: "02" };
const ALICE = { login: "alice", name: "Alice" };
const ELLEN = { login: "ellen", name: "Ellen" };

let clock: FixedClock;
let desk: InMemoryFeedbackDesk;

const install = (feedbackDesk: FeedbackDesk, anonymous = false) =>
  configureAdapters({ ...anonymousAdapters({ clock, renderer: new PassThroughRenderer() }), anonymous, feedbackDesk });

beforeEach(() => {
  vi.useFakeTimers();
  clock = new FixedClock();
  desk = new InMemoryFeedbackDesk({ clock, educators: { cs101: ["ellen"] } });
  feedbackService.reset();
  helpQueueService.reset();
});

afterEach(() => {
  feedbackService.reset();
  helpQueueService.reset();
  configureAdapters(anonymousAdapters());
  vi.useRealTimers();
});

describe("feedbackService", () => {
  it("offers nothing in anonymous mode or signed out, and reads nothing", async () => {
    install(desk.as(ALICE), true);
    await feedbackService.arrive(REF, "alice");
    expect(feedbackService.available.value).toBe(false);
    install(desk.as(ALICE));
    await feedbackService.arrive(REF, null);
    expect(feedbackService.available.value).toBe(false);
    expect(await feedbackService.broadcast("x")).toBe(false);
    expect(await feedbackService.share({ ref: REF, body: "x", kind: "note", updatedAt: "" })).toBe(false);
    await feedbackService.readReceived("cs101");
    expect(feedbackService.received.value).toBeNull();
  });

  it("keeps what is on screen when a read fails, and skips the poll while the tab is hidden", async () => {
    await desk.as(ELLEN).broadcast(REF, "Await the fetch.");
    const student = desk.as(ALICE);
    install(student);
    await feedbackService.arrive(REF, "alice");
    expect(feedbackService.banners()).toHaveLength(1);
    const step = vi.spyOn(student, "step").mockRejectedValue(new Error("offline"));
    await vi.advanceTimersByTimeAsync(FEEDBACK_POLL_MS);
    expect(feedbackService.banners()).toHaveLength(1);
    const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    step.mockClear();
    await vi.advanceTimersByTimeAsync(FEEDBACK_POLL_MS);
    expect(step).not.toHaveBeenCalled();
    hidden.mockRestore();
  });

  it("clears the step's feedback on moving to another step, and a dismissed banner stays dismissed", async () => {
    await desk.as(ELLEN).broadcast(REF, "Await the fetch.");
    install(desk.as(ALICE));
    await feedbackService.arrive(REF, "alice");
    const [banner] = feedbackService.banners();
    feedbackService.dismiss(banner.id);
    feedbackService.dismiss(banner.id);
    expect(feedbackService.banners()).toEqual([]);
    expect(feedbackService.dismissed.value).toEqual([banner.id]);
    await feedbackService.arrive({ ...REF, stepId: "03" }, "alice");
    expect(feedbackService.view.value.broadcasts).toEqual([]);
    await feedbackService.arrive(REF, "alice");
    expect(feedbackService.banners()).toEqual([]);
  });

  it("posts as an educator, keeps a refusal's reason, and replies to a reflection", async () => {
    const student = desk.as(ALICE);
    const shared = await student.reflect({ ref: REF, body: "Found it", kind: "discovery", updatedAt: "" });
    install(desk.as(ELLEN));
    await feedbackService.arrive(REF, "alice");
    expect(feedbackService.view.value.history?.reflections).toHaveLength(1);
    expect(await feedbackService.annotate("alice", "Nearly.")).toBe(true);
    expect(await feedbackService.reply(shared.ok ? shared.reflection : (null as never), "Good catch.")).toBe(true);
    expect(feedbackService.view.value.history?.annotations).toHaveLength(2);
    expect(await feedbackService.broadcast("  ")).toBe(false);
    expect(feedbackService.failure.value).toBe("invalid");
    const kept = feedbackService.view.value.history!.annotations[0];
    expect(await feedbackService.revoke(kept.id)).toBe(true);
    expect(feedbackService.failure.value).toBeNull();
    expect(feedbackService.render("**x**")).toContain("**x**");
  });

  it("does nothing off a step, and one post at a time", async () => {
    install(desk.as(ELLEN));
    expect(await feedbackService.broadcast("x")).toBe(false);
    expect(await feedbackService.annotate("alice", "x")).toBe(false);
    await feedbackService.arrive(REF, "alice");
    const first = feedbackService.broadcast("one");
    expect(await feedbackService.broadcast("two")).toBe(false);
    expect(await first).toBe(true);
  });

  it("shares a note, says why one was not shared, and reads what was received", async () => {
    install(desk.as(ALICE));
    await feedbackService.arrive(REF, "alice");
    expect(await feedbackService.share({ ref: REF, body: " ", kind: "note", updatedAt: "" })).toBe(false);
    expect(feedbackService.failure.value).toBe("no-note");
    expect(await feedbackService.share({ ref: REF, body: "Found it", kind: "note", updatedAt: "" })).toBe(true);
    await desk.as(ELLEN).broadcast(REF, "For everyone");
    await feedbackService.readReceived("cs101");
    expect(feedbackService.received.value?.map((a) => a.body)).toEqual(["For everyone"]);
    const failing = desk.as(ALICE);
    vi.spyOn(failing, "received").mockRejectedValue(new Error("offline"));
    install(failing);
    await feedbackService.readReceived("cs101");
    expect(feedbackService.received.value).toHaveLength(1);
  });

  it("the signed-out desk reads nothing and refuses everything", async () => {
    const none = new SignedOutFeedbackDesk();
    expect(await none.step()).toEqual({ broadcasts: [], personal: [], history: null });
    expect(await none.received()).toEqual([]);
    for (const refused of [await none.annotate(), await none.broadcast(), await none.revoke(), await none.reflect()]) expect(refused).toEqual({ ok: false, reason: "signed-out" });
  });
});

describe("the help queue's explanation offer", () => {
  it("is not posted when empty or refused, and shows a broadcast heard on the stream until it is revoked", async () => {
    const help = new InMemoryHelpDesk({ clock, educators: { cs101: ["ellen"] } });
    const feedback = new InMemoryFeedbackDesk({ clock, feed: help.feed, educators: { cs101: ["ellen"] } });
    configureAdapters({ ...anonymousAdapters({ clock }), anonymous: false, helpDesk: help.as(ELLEN), feedbackDesk: feedback.as(ALICE), assistanceFeed: help.feed });
    await helpQueueService.start("cs101");
    const asked = await help.as(ALICE).ask(REF, "stuck");
    expect(await helpQueueService.resolve(asked.ok ? asked.request.id : "")).toBe(true);
    const [offer] = helpQueueService.offers.value;
    expect(await helpQueueService.explain(offer.id, " ")).toBe(false);
    expect(await helpQueueService.explain("nope", "x")).toBe(false);
    expect(await helpQueueService.explain(offer.id, "Because.")).toBe(false);
    expect(helpQueueService.explainFailed.value).toBe(true);
    const posted = await feedback.as(ELLEN).broadcast({ ...REF, stepId: "05" }, "Heard on the stream");
    expect(helpQueueService.explanations.value.map((a) => a.body)).toEqual(["Heard on the stream"]);
    await feedback.as(ELLEN).annotate({ ref: REF }, { learnerId: "alice" }, "Not a broadcast");
    expect(helpQueueService.explanations.value).toHaveLength(1);
    await feedback.as(ELLEN).revoke(posted.ok ? posted.annotation.id : "");
    expect(helpQueueService.explanations.value).toEqual([]);
  });

  it("posts one explanation at a time, and offers nothing for a course the lecturer has left", async () => {
    const help = new InMemoryHelpDesk({ clock, educators: { cs101: ["ellen"], cs102: ["ellen"] } });
    const feedback = new InMemoryFeedbackDesk({ clock, feed: help.feed, educators: { cs101: ["ellen"] } });
    configureAdapters({ ...anonymousAdapters({ clock }), anonymous: false, helpDesk: help.as(ELLEN), feedbackDesk: feedback.as(ELLEN), assistanceFeed: help.feed });
    await helpQueueService.start("cs101");
    const asked = await help.as(ALICE).ask(REF, "stuck");
    const id = asked.ok ? asked.request.id : "";
    expect(await helpQueueService.resolve(id)).toBe(true);
    const first = helpQueueService.explain(id, "Because.");
    expect(helpQueueService.explaining.value).toEqual([id]);
    expect(await helpQueueService.explain(id, "Because.")).toBe(false);
    expect(await first).toBe(true);
    expect(helpQueueService.explaining.value).toEqual([]);
    expect(feedback.store.annotations).toHaveLength(1);

    const again = await help.as(ALICE).ask({ ...REF, stepId: "03" }, "stuck");
    const resolving = helpQueueService.resolve(again.ok ? again.request.id : "");
    await helpQueueService.start("cs102");
    expect(await resolving).toBe(true);
    expect(helpQueueService.offers.value).toEqual([]);
  });

  it("forgets the last person's feedback when someone else signs in, and keeps no older read of it", async () => {
    await desk.as(ELLEN).annotate({ ref: REF }, { learnerId: "alice" }, "For alice.");
    install(desk.as(ALICE));
    await feedbackService.arrive(REF, "alice");
    feedbackService.dismiss("x");
    const late = feedbackService.readReceived("cs101");
    install(desk.as({ login: "bob", name: "Bob" }));
    await feedbackService.arrive(REF, "bob");
    await late;
    expect(feedbackService.received.value).toBeNull();
    expect(feedbackService.dismissed.value).toEqual([]);
    await feedbackService.readReceived("cs101");
    expect(feedbackService.received.value).toEqual([]);
    await feedbackService.readReceived("cs102");
    expect(feedbackService.received.value).toEqual([]);
  });
});
