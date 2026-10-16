/**
 * The reader server's side of lecturer feedback (the Feedback context): the use cases over the
 * Postgres FeedbackStore the composition root picked, the Valkey feed Tutors Live watches, the
 * course notices a broadcast is toasted on, the course's educators from its published enrollment,
 * and the parsing of what a browser posts to /api/feedback. Every write runs here, as the session's
 * actor; a browser only asks.
 */
import { clock } from "@tutors/clock";
import {
  annotate,
  broadcast,
  MAX_ANNOTATION_CHARS,
  receivedFeedback,
  revokeAnnotation,
  shareReflection,
  stepFeedback,
  stepHistory,
  type AnnotationInput,
  type FeedbackDeps
} from "@tutors/application";
import type { NotesStore } from "@tutors/application/ports";
import { isNoteKind, stepRef, type Note, type NoteKind, type StepRef } from "@tutors/domain/learning";
import { readerServer } from "./api/adapters.ts";
import { educatorsOf, serverNotices } from "./snippets.ts";

/** The use cases over this server's adapters, or null when it keeps no feedback (anonymous mode, or not on Postgres). */
export function feedback(fetchFn: typeof fetch) {
  const { data, realtime } = readerServer();
  if (!data?.feedback) return null;
  const deps: FeedbackDeps = { store: data.feedback, clock, educatorsOf: (courseId) => educatorsOf(courseId, (url) => fetchFn(url)) };
  return {
    step: stepFeedback(deps),
    history: stepHistory(deps),
    received: receivedFeedback(deps),
    annotate: annotate(deps),
    broadcast: broadcast({ ...deps, feed: realtime.assistance, notices: serverNotices }),
    revoke: revokeAnnotation({ ...deps, feed: realtime.assistance }),
    /** The note the student sent, shared as a reflection: the server keeps no notes, so the post is the note (Rule 0384). */
    reflect: (note: Note, learnerId: string) => shareReflection({ store: deps.store, notes: postedNote(note), clock })(note.ref, learnerId),
    educatorsOf: deps.educatorsOf
  };
}

/** A notes store holding only the note a browser posted. */
function postedNote(note: Note): NotesStore {
  return {
    get: async () => note,
    put: async () => {},
    remove: async () => {},
    forCourse: async () => [note]
  };
}

/** What a browser posts: an annotation, a broadcast, a revoke, or a student's note shared as a reflection. */
export type FeedbackPost =
  | { action: "annotate"; input: AnnotationInput }
  | { action: "broadcast"; ref: StepRef; body: string; stepTitle: string | null }
  | { action: "revoke"; id: string }
  | { action: "reflect"; ref: StepRef; kind: NoteKind; body: string };

const text = (value: unknown, max: number): string | null => (typeof value === "string" && value.trim() && value.length <= max ? value.trim() : null);
const optional = (value: unknown, max: number): string | null | undefined => (value === undefined || value === null || value === "" ? null : (text(value, max) ?? undefined));

/** The step a post names, or why it does not name one of the course's labs. */
export function parseStep(body: Record<string, unknown>): StepRef | string {
  const ref = stepRef(text(body.courseId, 200), text(body.labRoute, 512), text(body.stepId, 200));
  if (!ref) return "courseId, labRoute and stepId are required";
  if (!ref.labRoute.startsWith(`/lab/${ref.courseId}/`)) return "labRoute is a lab of the course, /lab/<courseId>/...";
  return ref;
}

const bodyOf = (value: unknown): string | null => (typeof value === "string" && value.length <= MAX_ANNOTATION_CHARS ? value : null);

/** The post, or why it is malformed. */
export function parseFeedbackPost(body: Record<string, unknown>): FeedbackPost | string {
  switch (body.action) {
    case "annotate":
    case "broadcast":
    case "reflect": {
      const ref = parseStep(body);
      if (typeof ref === "string") return ref;
      const text = bodyOf(body.body);
      if (text === null) return `body is text of at most ${MAX_ANNOTATION_CHARS} characters`;
      if (body.action === "broadcast") {
        const stepTitle = optional(body.stepTitle, 200);
        if (stepTitle === undefined) return "stepTitle is text of at most 200 characters";
        return { action: "broadcast", ref, body: text, stepTitle };
      }
      if (body.action === "reflect") return isNoteKind(body.kind) ? { action: "reflect", ref, kind: body.kind, body: text } : "kind is a note kind";
      const snippetId = optional(body.snippetId, 200);
      const reflectionId = optional(body.reflectionId, 64);
      const learnerId = optional(body.learnerId, 200);
      if (snippetId === undefined || reflectionId === undefined || learnerId === undefined) return "snippetId, reflectionId and learnerId are text";
      if (body.everyone !== undefined && typeof body.everyone !== "boolean") return "everyone is true or false";
      return { action: "annotate", input: { anchor: { ref, snippetId, reflectionId }, audience: { learnerId, everyone: body.everyone === true }, body: text } };
    }
    case "revoke": {
      const id = text(body.id, 64);
      return id ? { action: "revoke", id } : "id is required";
    }
    default:
      return "action is one of annotate, broadcast, revoke, reflect";
  }
}

/** The messages each refusal answers with. */
export const FEEDBACK_MESSAGES: Record<string, string> = {
  invalid: "That is not feedback tutors can keep",
  forbidden: "Only an educator of the course may do that",
  "not-found": "No such annotation",
  "no-note": "There is nothing in the note to share",
  unavailable: "The feedback was not sent; try again"
};
