/**
 * One student's part in the assistance and feedback contexts, and the shape of a course's cohort:
 * pure counts over stored rows.
 */
import type { HelpRequest } from "../assistance/help-request.ts";
import type { Annotation } from "../feedback/annotation.ts";
import type { Reflection } from "../feedback/reflection.ts";

export type StudentProgress = {
  learnerId: string;
  requestsRaised: number;
  hintsRead: number;
  annotationsReceived: number;
  reflectionsShared: number;
};

/** Annotations reach a student when addressed to them, or to everyone on a step they asked about or reflected on. */
export function studentProgress(learnerId: string, requests: readonly HelpRequest[], annotations: readonly Annotation[], reflections: readonly Reflection[]): StudentProgress {
  const own = requests.filter((r) => r.learnerId === learnerId);
  return {
    learnerId,
    requestsRaised: own.length,
    hintsRead: own.filter((r) => r.closed?.reason === "hint").length,
    annotationsReceived: annotations.filter((a) => a.revokedAt === null && a.audience.kind === "student" && a.audience.learnerId === learnerId).length,
    reflectionsShared: reflections.filter((r) => r.learnerId === learnerId).length
  };
}

/** Fewer students than this in a period, and percentiles are withheld so no one student can be read off them. */
export const MIN_COHORT_FOR_PERCENTILES = 5;

export type CohortProfile = { courseId: string; students: number; percentilesShown: boolean };

export function cohortProfile(courseId: string, learnerIds: Iterable<string>): CohortProfile {
  const students = new Set(learnerIds).size;
  return { courseId, students, percentilesShown: students >= MIN_COHORT_FOR_PERCENTILES };
}
