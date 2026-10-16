/**
 * What a page asks of lecturer feedback, as the person signed in to it: a student reads what was
 * posted for them at a step and in the course and shares a note as a reflection; an educator reads
 * a step's history, annotates, broadcasts and revokes. The browser never keeps an annotation
 * itself: an adapter sends each ask to whoever runs the Feedback use cases as the session's actor
 * (the reader's server, /api/feedback) and answers with what was kept.
 */
import type { Annotation, AnchorInput, AudienceInput, Reflection, StepFeedback } from "@tutors/domain/feedback";
import type { Note, StepRef } from "@tutors/domain/learning";

/**
 * Why an ask was not kept: the Feedback use cases' refusals, plus `signed-out` (nobody is signed
 * in, or the deployment has no sign-in), `not-kept` (the deployment keeps no feedback) and
 * `no-note` (an empty note cannot be shared).
 */
export type FeedbackDeskRefusal = "invalid" | "forbidden" | "not-found" | "unavailable" | "signed-out" | "not-kept" | "no-note";

export type FeedbackDeskResult = { ok: true; annotation: Annotation } | { ok: false; reason: FeedbackDeskRefusal; detail?: string };
export type ReflectionDeskResult = { ok: true; reflection: Reflection } | { ok: false; reason: FeedbackDeskRefusal };

/** A step as the person signed in sees it: their broadcasts and annotations, and for an educator of the course the step's history. */
export type StepFeedbackView = StepFeedback & { history: { annotations: Annotation[]; reflections: Reflection[] } | null };

export interface FeedbackDesk {
  /** The step's feedback for the person signed in; nothing for a visitor. Rejects when it could not be read. */
  step(ref: StepRef): Promise<StepFeedbackView>;
  /** What the signed-in student received in a course, newest first; nothing for a visitor. Rejects when it could not be read. */
  received(courseId: string): Promise<Annotation[]>;
  /** An educator annotates a step, a snippet or a reflection for one student or everyone (Rules 0400, 0401). */
  annotate(anchor: AnchorInput, audience: AudienceInput, body: string): Promise<FeedbackDeskResult>;
  /** An educator explains something to everyone on a step: a banner there and a toast elsewhere in the course (Rules 0405, 0564). */
  broadcast(ref: StepRef, body: string, stepTitle?: string): Promise<FeedbackDeskResult>;
  /** An educator revokes an annotation (Rule 0406). */
  revoke(id: string): Promise<FeedbackDeskResult>;
  /** The signed-in student shares a step's note with the course's educators as a reflection (Rule 0384). */
  reflect(note: Note): Promise<ReflectionDeskResult>;
}
