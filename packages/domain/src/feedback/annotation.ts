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
