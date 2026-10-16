/**
 * The FeedbackDesk port in memory: the Feedback use cases themselves, run as a signed-in actor over
 * the in-memory store, feed and notices, as the reader's server runs them over Postgres and Valkey.
 * Desks made with `as` share the store, the feed and the clock, so a lecturer's desk and a
 * student's desk see the same annotations. With no actor every ask is refused as `signed-out`.
 */
import { isEducatorOf } from "@tutors/domain/access";
import type { Annotation, AnchorInput, AudienceInput } from "@tutors/domain/feedback";
import type { Note, StepRef } from "@tutors/domain/learning";
import { annotate, broadcast, receivedFeedback, revokeAnnotation, shareReflection, stepFeedback, stepHistory, type FeedbackDeps } from "../feedback/feedback.ts";
import type { Clock } from "../ports/clock.ts";
import type { FeedbackDesk, FeedbackDeskRefusal, FeedbackDeskResult, ReflectionDeskResult, StepFeedbackView } from "../ports/feedback-desk.ts";
import { FixedClock, InMemoryCourseNotices } from "./in-memory.ts";
import { InMemoryAssistanceFeed, InMemoryFeedbackStore, InMemoryNotesStore } from "./learning-contexts.ts";

export type FeedbackDeskActor = { login: string; name: string | null };

export type InMemoryFeedbackDeskOptions = {
  store?: InMemoryFeedbackStore;
  feed?: InMemoryAssistanceFeed;
  notices?: InMemoryCourseNotices;
  clock?: Clock;
  /** Each course's educator logins. */
  educators?: Record<string, string[]>;
  actor?: FeedbackDeskActor | null;
};

export class InMemoryFeedbackDesk implements FeedbackDesk {
  readonly store: InMemoryFeedbackStore;
  readonly feed: InMemoryAssistanceFeed;
  readonly notices: InMemoryCourseNotices;
  readonly clock: Clock;
  readonly educators: Record<string, string[]>;
  readonly actor: FeedbackDeskActor | null;
  /** How many times each read was made, for a test that counts reads. */
  readonly calls = { step: 0, received: 0 };

  constructor(options: InMemoryFeedbackDeskOptions = {}) {
    this.store = options.store ?? new InMemoryFeedbackStore();
    this.feed = options.feed ?? new InMemoryAssistanceFeed();
    this.notices = options.notices ?? new InMemoryCourseNotices();
    this.clock = options.clock ?? new FixedClock();
    this.educators = options.educators ?? {};
    this.actor = options.actor ?? null;
  }

  /** A desk over the same annotations, signed in as someone else (or nobody). */
  as(actor: FeedbackDeskActor | null): InMemoryFeedbackDesk {
    return new InMemoryFeedbackDesk({ store: this.store, feed: this.feed, notices: this.notices, clock: this.clock, educators: this.educators, actor });
  }

  private deps(): FeedbackDeps {
    return { store: this.store, clock: this.clock, educatorsOf: async (courseId) => this.educators[courseId] ?? [] };
  }

  private static refused(reason: string): FeedbackDeskRefusal {
    return reason === "no-note" || reason === "not-found" || reason === "forbidden" || reason === "invalid" ? reason : "unavailable";
  }

  private static answer(result: { ok: true; annotation: Annotation } | { ok: false; reason: string; detail?: string }): FeedbackDeskResult {
    if (result.ok) return { ok: true, annotation: result.annotation };
    return result.detail
      ? { ok: false, reason: InMemoryFeedbackDesk.refused(result.reason), detail: result.detail }
      : { ok: false, reason: InMemoryFeedbackDesk.refused(result.reason) };
  }

  async step(ref: StepRef): Promise<StepFeedbackView> {
    this.calls.step++;
    if (!this.actor) return { broadcasts: [], personal: [], history: null };
    const shown = await stepFeedback(this.deps())(ref, this.actor.login);
    const educator = isEducatorOf(this.actor.login, { educators: this.educators[ref.courseId] ?? [] });
    if (!educator) return { ...shown, history: null };
    const history = await stepHistory(this.deps())(ref, this.actor);
    if (!history.ok) throw new Error("the step's history could not be read");
    return { ...shown, history: history.history };
  }

  async received(courseId: string): Promise<Annotation[]> {
    this.calls.received++;
    if (!this.actor) return [];
    return receivedFeedback(this.deps())(courseId, this.actor.login);
  }

  async annotate(anchor: AnchorInput, audience: AudienceInput, body: string): Promise<FeedbackDeskResult> {
    if (!this.actor) return { ok: false, reason: "signed-out" };
    return InMemoryFeedbackDesk.answer(await annotate(this.deps())({ anchor, audience, body }, this.actor));
  }

  async broadcast(ref: StepRef, body: string, stepTitle?: string): Promise<FeedbackDeskResult> {
    if (!this.actor) return { ok: false, reason: "signed-out" };
    return InMemoryFeedbackDesk.answer(
      await broadcast({ ...this.deps(), feed: this.feed, notices: this.notices })(ref, body, this.actor, { stepTitle, senderName: this.actor.name })
    );
  }

  async revoke(id: string): Promise<FeedbackDeskResult> {
    if (!this.actor) return { ok: false, reason: "signed-out" };
    return InMemoryFeedbackDesk.answer(await revokeAnnotation({ ...this.deps(), feed: this.feed })(id, this.actor));
  }

  async reflect(note: Note): Promise<ReflectionDeskResult> {
    if (!this.actor) return { ok: false, reason: "signed-out" };
    const notes = new InMemoryNotesStore();
    await notes.put(note);
    const result = await shareReflection({ store: this.store, notes, clock: this.clock })(note.ref, this.actor.login);
    return result.ok ? result : { ok: false, reason: result.reason };
  }
}
