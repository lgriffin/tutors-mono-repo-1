/**
 * How a lab step went on a day, from the stored requests and annotations of that step (Rule 0411):
 * requests by kind, how many a lecturer acknowledged, the median and 90th percentile wait, how
 * many requests ended helped by a hint, and the annotations posted.
 */
import { HELP_KINDS, type HelpKind, type HelpRequest } from "../assistance/help-request.ts";
import type { Annotation } from "../feedback/annotation.ts";
import { sameStep, stepKey, type StepRef } from "../learning/step-ref.ts";
import { median, percentile } from "./statistics.ts";

export type StepDiagnostic = {
  ref: StepRef;
  /** The day, `YYYY-MM-DD`, of the requests' raising (UTC). */
  day: string;
  requests: Record<HelpKind, number>;
  acknowledged: number;
  medianWaitSeconds: number | null;
  p90WaitSeconds: number | null;
  helpedByHint: number;
  annotations: number;
};

const dayOf = (iso: string) => iso.slice(0, 10);

/**
 * A request's wait: until a lecturer acknowledged it, or until it ended when nobody did. A request
 * still waiting has no wait yet and is left out of the statistics.
 */
export function waitSeconds(request: HelpRequest): number | null {
  const end = request.acknowledged?.at ?? request.closed?.at;
  if (!end) return null;
  return Math.max(0, Math.round((Date.parse(end) - Date.parse(request.requestedAt)) / 1000));
}

export function stepDiagnostic(ref: StepRef, day: string, requests: readonly HelpRequest[], annotations: readonly Annotation[]): StepDiagnostic {
  const atStep = requests.filter((r) => sameStep(r.ref, ref) && dayOf(r.requestedAt) === day);
  const byKind = Object.fromEntries(HELP_KINDS.map((k) => [k, atStep.filter((r) => r.kind === k).length])) as Record<HelpKind, number>;
  const waits = atStep.map(waitSeconds).filter((w): w is number => w !== null);
  return {
    ref,
    day,
    requests: byKind,
    acknowledged: atStep.filter((r) => r.acknowledged !== null).length,
    medianWaitSeconds: median(waits),
    p90WaitSeconds: percentile(waits, 90),
    helpedByHint: atStep.filter((r) => r.closed?.reason === "hint").length,
    annotations: annotations.filter((a) => sameStep(a.anchor.ref, ref) && dayOf(a.createdAt) === day).length
  };
}

/** A diagnostic for every step that had a request or an annotation on the day, in step order. */
export function stepDiagnostics(day: string, requests: readonly HelpRequest[], annotations: readonly Annotation[]): StepDiagnostic[] {
  const steps = new Map<string, StepRef>();
  for (const r of requests) if (dayOf(r.requestedAt) === day) steps.set(stepKey(r.ref), r.ref);
  for (const a of annotations) if (dayOf(a.createdAt) === day) steps.set(stepKey(a.anchor.ref), a.anchor.ref);
  return [...steps.entries()].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })).map(([, ref]) => stepDiagnostic(ref, day, requests, annotations));
}
