/**
 * The feedback use cases: an educator annotates a step, a shared snippet or a shared reflection for
 * one student or for everyone on the step; a broadcast is the annotation for everyone, also told
 * to the course's watching Live tabs; a student shares a private note as a reflection. Feedback
 * reads the notes through their port and never imports another context's use cases.
 */
import { isEducatorOf } from "@tutors/domain/access";
import { anchorOf, audienceOf, reflectionFromNote, type Annotation, type AnchorInput, type AudienceInput, type Reflection } from "@tutors/domain/feedback";
import type { StepRef } from "@tutors/domain/learning";
import type { AssistanceFeed } from "../ports/assistance-feed.ts";
import type { Clock } from "../ports/clock.ts";
import type { EventPublisher } from "../ports/event-publisher.ts";
import type { FeedbackStore } from "../ports/feedback-store.ts";
import type { NotesStore } from "../ports/notes-store.ts";

export type FeedbackDeps = {
  store: FeedbackStore;
  clock: Clock;
  /** Who teaches a course, as its published enrollment lists them (`courseEducators`). */
  educatorsOf: (courseId: string) => Promise<string[]>;
  publish?: EventPublisher["publish"];
};

export type AnnotationInput = { anchor: AnchorInput; audience: AudienceInput; body: string };

/** Refusals carry the status the reader's server answers with. */
export type FeedbackRefusal =
  { ok: false; reason: "invalid"; detail: string; status: 400 } | { ok: false; reason: "forbidden"; status: 403 } | { ok: false; reason: "unavailable"; status: 503 };

export type AnnotateResult = { ok: true; annotation: Annotation } | FeedbackRefusal;

/** The longest annotation body, in characters: an explanation, not a document. */
export const MAX_ANNOTATION_CHARS = 4000;

/**
 * An educator posts an annotation: stored with its author and the clock's time, then a
 * feedback-posted event (Rule 0401). An actor the course's educator list does not name is refused
 * with 403 and nothing is stored (Rule 0402).
 */
export function annotate({ store, clock, educatorsOf, publish }: FeedbackDeps) {
  return async (input: AnnotationInput, author: { login: string }): Promise<AnnotateResult> => {
    const educators = await educatorsOf(input.anchor.ref.courseId).catch(() => null);
    if (educators === null) return { ok: false, reason: "unavailable", status: 503 };
    if (!isEducatorOf(author.login, { educators })) return { ok: false, reason: "forbidden", status: 403 };
    const anchor = anchorOf(input.anchor);
    if (typeof anchor === "string") return { ok: false, reason: "invalid", detail: anchor, status: 400 };
    const audience = audienceOf(input.audience);
    if (typeof audience === "string") return { ok: false, reason: "invalid", detail: audience, status: 400 };
    const body = input.body.trim();
    if (!body || body.length > MAX_ANNOTATION_CHARS) return { ok: false, reason: "invalid", detail: "body", status: 400 };
    let annotation: Annotation;
    try {
      annotation = await store.annotate({ anchor, audience, body, authorId: author.login, createdAt: clock.now().toISOString() });
    } catch {
      return { ok: false, reason: "unavailable", status: 503 };
    }
    await publish?.({ type: "feedback-posted", annotation });
    return { ok: true, annotation };
  };
}

/**
 * An educator explains something to everyone on a step: an annotation for everyone, then one
 * annotation change to the course's watchers. A feed that fails does not undo the broadcast.
 */
export function broadcast(deps: FeedbackDeps & { feed: AssistanceFeed }) {
  const post = annotate(deps);
  return async (ref: StepRef, body: string, author: { login: string }): Promise<AnnotateResult> => {
    const result = await post({ anchor: { ref }, audience: { everyone: true }, body }, author);
    if (result.ok) await deps.feed.publish({ type: "annotation", courseId: ref.courseId, annotation: result.annotation }).catch(() => false);
    return result;
  };
}

export type ShareReflectionResult = { ok: true; reflection: Reflection } | { ok: false; reason: "no-note" | "unavailable" };

/**
 * A student shares the note of a step as a reflection: the feedback context gets a copy and the
 * private note is left as it was (Rule 0384).
 */
export function shareReflection({ store, notes, clock }: { store: FeedbackStore; notes: NotesStore; clock: Clock }) {
  return async (ref: StepRef, learnerId: string): Promise<ShareReflectionResult> => {
    try {
      const note = await notes.get(ref);
      if (!note || !note.body.trim()) return { ok: false, reason: "no-note" };
      return { ok: true, reflection: await store.reflect(reflectionFromNote(note, learnerId, clock.now().toISOString())) };
    } catch {
      return { ok: false, reason: "unavailable" };
    }
  };
}
