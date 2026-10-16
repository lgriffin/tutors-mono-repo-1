/**
 * Lecturer feedback: an annotation anchored to exactly one thing a student did at a step (the step
 * itself, a shared snippet, a shared reflection) and addressed to one student or to everyone on
 * the step (Rule 0400). An annotation to everyone is a broadcast.
 */
import type { StepRef } from "../learning/step-ref.ts";

export type Anchor =
  | { kind: "step"; ref: StepRef }
  /** A shared snippet is the submission a lecturer annotates (decisions D8, D9). */
  | { kind: "snippet"; ref: StepRef; snippetId: string }
  | { kind: "reflection"; ref: StepRef; reflectionId: string };

export type Audience = { kind: "student"; learnerId: string } | { kind: "everyone" };

export type Annotation = {
  id: string;
  anchor: Anchor;
  audience: Audience;
  /** Markdown, rendered and sanitised as lab content is. */
  body: string;
  authorId: string;
  createdAt: string;
  revokedAt: string | null;
};

export type NewAnnotation = Omit<Annotation, "id" | "revokedAt">;

/** What a lecturer's composer sends: the step, at most one of a snippet or a reflection, and who it is for. */
export type AnchorInput = { ref: StepRef; snippetId?: string | null; reflectionId?: string | null };
export type AudienceInput = { learnerId?: string | null; everyone?: boolean };

export type AnchorRefusal = "two-anchors" | "two-audiences" | "no-audience";

const present = (s: string | null | undefined): s is string => typeof s === "string" && s.trim().length > 0;

/** The one anchor the input names, or the reason it names more than one. */
export function anchorOf(input: AnchorInput): Anchor | AnchorRefusal {
  const snippet = present(input.snippetId);
  const reflection = present(input.reflectionId);
  if (snippet && reflection) return "two-anchors";
  if (snippet) return { kind: "snippet", ref: input.ref, snippetId: input.snippetId!.trim() };
  if (reflection) return { kind: "reflection", ref: input.ref, reflectionId: input.reflectionId!.trim() };
  return { kind: "step", ref: input.ref };
}

/** The one audience the input names: a student, or everyone on the step. */
export function audienceOf(input: AudienceInput): Audience | AnchorRefusal {
  const student = present(input.learnerId);
  if (student && input.everyone) return "two-audiences";
  if (student) return { kind: "student", learnerId: input.learnerId!.trim() };
  if (input.everyone) return { kind: "everyone" };
  return "no-audience";
}

export function isBroadcast(annotation: Pick<Annotation, "audience">): boolean {
  return annotation.audience.kind === "everyone";
}

export function isRevoked(annotation: Annotation): boolean {
  return annotation.revokedAt !== null;
}

/** True when the annotation is for this learner: addressed to them, or to everyone on its step. */
export function isFor(annotation: Pick<Annotation, "audience">, learnerId: string): boolean {
  return annotation.audience.kind === "everyone" || annotation.audience.learnerId === learnerId;
}

/** What a student sees at a step: the broadcasts above the content and what was addressed to them below it (Rule 0403). */
export type StepFeedback = { broadcasts: Annotation[]; personal: Annotation[] };

/**
 * A student's view of a step's annotations, from the one read of the step: unrevoked broadcasts and
 * the unrevoked annotations addressed to `learnerId`, oldest first. Another student's annotation
 * is never in it.
 */
export function feedbackFor(annotations: readonly Annotation[], learnerId: string): StepFeedback {
  const shown = annotations.filter((a) => !isRevoked(a) && isFor(a, learnerId)).sort(oldestFirst);
  return { broadcasts: shown.filter(isBroadcast), personal: shown.filter((a) => !isBroadcast(a)) };
}

export function oldestFirst(a: Pick<Annotation, "createdAt" | "id">, b: Pick<Annotation, "createdAt" | "id">): number {
  return a.createdAt === b.createdAt ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.createdAt < b.createdAt ? -1 : 1;
}

/** Newest first, as a history reads (Rule 0409). */
export function newestFirst<T extends Pick<Annotation, "createdAt" | "id">>(annotations: readonly T[]): T[] {
  return [...annotations].sort((a, b) => oldestFirst(b, a));
}

/** The annotation revoked at `at`; one already revoked keeps its first revocation time (Rule 0406). */
export function revokedAt(annotation: Annotation, at: string): Annotation {
  return isRevoked(annotation) ? annotation : { ...annotation, revokedAt: at };
}
