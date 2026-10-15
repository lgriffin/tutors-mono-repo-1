/**
 * Evidence of learning at a step: a shared snippet, a reflection, a private note. Evidence is the
 * Learning context's own vocabulary; the snippet and reflection records themselves stay with the
 * contexts that keep them, and evidence points at them by id.
 */
import { sameStep, type StepRef } from "./step-ref.ts";

export const EVIDENCE_KINDS = ["snippet", "reflection", "note"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export type Evidence = {
  kind: EvidenceKind;
  ref: StepRef;
  /** The id of the record the evidence is: a snippet's id, a reflection's id, a note's key. */
  id: string;
  /** When it was recorded, as an ISO instant. */
  at: string;
};

export function isEvidenceKind(value: unknown): value is EvidenceKind {
  return typeof value === "string" && (EVIDENCE_KINDS as readonly string[]).includes(value);
}

/** The evidence recorded at one step, newest first (Rule 0378). */
export function evidenceAtStep(evidence: readonly Evidence[], ref: StepRef): Evidence[] {
  return evidence.filter((e) => sameStep(e.ref, ref)).sort((a, b) => b.at.localeCompare(a.at));
}
