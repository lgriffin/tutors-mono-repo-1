/**
 * The feedback use cases: an educator annotates a step, a shared snippet or a shared reflection for
 * one student or for everyone on the step; a broadcast is the annotation for everyone, also told
 * to the course's watching Live tabs; a student shares a private note as a reflection. Feedback
 * reads the notes through their port and never imports another context's use cases.
 */
import { isEducatorOf } from "@tutors/domain/access";
import {
  anchorOf,
  audienceOf,
  feedbackFor,
  newestFirst,
  reflectionFromNote,
  type Annotation,
  type AnchorInput,
  type AudienceInput,
  type Reflection,
  type StepFeedback
} from "@tutors/domain/feedback";
import type { StepRef } from "@tutors/domain/learning";
import type { AssistanceFeed } from "../ports/assistance-feed.ts";
import type { Clock } from "../ports/clock.ts";
import type { CourseNotices, LecturerBroadcast } from "../ports/course-notices.ts";
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

/** How a broadcast is announced as a toast to the course's students elsewhere in it (decision D5). */
export type BroadcastToast = { stepTitle?: string | null; senderName?: string | null };

/** The longest toast description: the start of the explanation, as a lecturer broadcast carries it. */
const TOAST_CHARS = 280;

/** The course notice a broadcast is toasted as: who explained what, on which step, with a link to it (Rule 0564). */
export function explanationNotice(annotation: Annotation, toast: BroadcastToast = {}): LecturerBroadcast {
  const ref = annotation.anchor.ref;
  const plain = annotation.body.replace(/\s+/g, " ").trim();
  return {
    type: "course:broadcast",
    id: `explanation-${annotation.id}`,
    courseId: ref.courseId,
    title: (toast.stepTitle?.trim() || ref.stepId).slice(0, 80),
    description: plain.length > TOAST_CHARS ? `${plain.slice(0, TOAST_CHARS - 1)}…` : plain,
    actionUrl: `${ref.labRoute}/${ref.stepId}`,
    senderName: toast.senderName?.trim() || "Tutor",
    sentAt: Date.parse(annotation.createdAt) || 0
  };
}

/**
 * An educator explains something to everyone on a step: an annotation for everyone, then one
 * annotation change to the course's watchers (Rule 0405) and, when notices are given, one toast to
 * the students reading the course (Rule 0564). A feed or notice that fails does not undo the broadcast.
 */
export function broadcast(deps: FeedbackDeps & { feed: AssistanceFeed; notices?: CourseNotices }) {
  const post = annotate(deps);
  return async (ref: StepRef, body: string, author: { login: string }, toast?: BroadcastToast): Promise<AnnotateResult> => {
    const result = await post({ anchor: { ref }, audience: { everyone: true }, body }, author);
    if (!result.ok) return result;
    await deps.feed.publish({ type: "annotation", courseId: ref.courseId, annotation: result.annotation }).catch(() => false);
    await deps.notices?.post(explanationNotice(result.annotation, toast)).catch(() => false);
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

/**
 * What a student sees at a step, from one read of the step's annotations: the unrevoked broadcasts
 * and the unrevoked annotations addressed to them (Rule 0403). Rejects when the store could not be read.
 */
export function stepFeedback({ store }: { store: FeedbackStore }) {
  return async (ref: StepRef, learnerId: string): Promise<StepFeedback> => feedbackFor(await store.forStep(ref), learnerId);
}

/** An educator's view of a step: every annotation posted there, revoked ones included, newest first, and the reflections shared there. */
export type StepHistory = { annotations: Annotation[]; reflections: Reflection[] };

export type StepHistoryResult = { ok: true; history: StepHistory } | FeedbackRefusal;

/**
 * What was posted on a step and when, for an educator of its course (Rule 0409): the review history
 * keeps a revoked annotation with its revocation time (Rule 0406). Anyone else is refused with 403.
 */
export function stepHistory({ store, educatorsOf }: Pick<FeedbackDeps, "store" | "educatorsOf">) {
  return async (ref: StepRef, actor: { login: string }): Promise<StepHistoryResult> => {
    const educators = await educatorsOf(ref.courseId).catch(() => null);
    if (educators === null) return { ok: false, reason: "unavailable", status: 503 };
    if (!isEducatorOf(actor.login, { educators })) return { ok: false, reason: "forbidden", status: 403 };
    try {
      const [annotations, reflections] = await Promise.all([store.forStep(ref), store.reflectionsAt(ref)]);
      return { ok: true, history: { annotations: newestFirst(annotations), reflections } };
    } catch {
      return { ok: false, reason: "unavailable", status: 503 };
    }
  };
}

/** The annotations a student received in a course, broadcasts included, newest first (Rule 0409). Rejects when the store could not be read. */
export function receivedFeedback({ store }: { store: FeedbackStore }) {
  return async (courseId: string, learnerId: string): Promise<Annotation[]> => newestFirst(await store.received(courseId, learnerId));
}

export type RevokeResult = { ok: true; annotation: Annotation } | FeedbackRefusal | { ok: false; reason: "not-found"; status: 404 };

/**
 * An educator of the annotation's course revokes it: students stop seeing it on their next read,
 * and it stays in the review history with the revocation time (Rule 0406). The course's watching
 * Live tabs hear the change when a feed is given.
 */
export function revokeAnnotation({ store, clock, educatorsOf, feed }: Pick<FeedbackDeps, "store" | "clock" | "educatorsOf"> & { feed?: AssistanceFeed }) {
  return async (id: string, actor: { login: string }): Promise<RevokeResult> => {
    let found: Annotation | null;
    try {
      found = await store.get(id);
    } catch {
      return { ok: false, reason: "unavailable", status: 503 };
    }
    if (!found) return { ok: false, reason: "not-found", status: 404 };
    const courseId = found.anchor.ref.courseId;
    const educators = await educatorsOf(courseId).catch(() => null);
    if (educators === null) return { ok: false, reason: "unavailable", status: 503 };
    if (!isEducatorOf(actor.login, { educators })) return { ok: false, reason: "forbidden", status: 403 };
    let revoked: Annotation | null;
    try {
      revoked = await store.revoke(id, clock.now().toISOString());
    } catch {
      return { ok: false, reason: "unavailable", status: 503 };
    }
    if (!revoked) return { ok: false, reason: "not-found", status: 404 };
    await feed?.publish({ type: "annotation", courseId, annotation: revoked }).catch(() => false);
    return { ok: true, annotation: revoked };
  };
}
