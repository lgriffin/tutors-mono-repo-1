/**
 * A learner's attempts at the steps of a lab, read from the learning records the reader already
 * stores (Rule 0376): there is no attempts table. The reader records a lab page under its own
 * address (`learningObjectRoute` with the page's route parameters): the lab's route, then the step
 * id. So a step's records name their lab, and two labs that reuse a step id never share a record.
 * Opening a lab at its own address shows its first step, recorded under the lab's route itself.
 */
import type { LearningRecordRow } from "./rows.ts";
import { stepKey, trimSlashes, type StepRef } from "./step-ref.ts";

export type Attempt = {
  ref: StepRef;
  learnerId: string;
  /** Page loads of the step. */
  visits: number;
  /** Active time in 30-second blocks, as the record stores it. */
  activeBlocks: number;
  lastAt: string | null;
  /** The record names a step the course no longer has (Rule 0379). */
  removed: boolean;
};

/** The lab the attempts are read for: where it lives in the reader, which is where its records live, and its steps today. */
export type LabSteps = {
  courseId: string;
  labRoute: string;
  stepIds: readonly string[];
};

/** The later of two ISO instants, either of which may be missing. */
const later = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b);

/**
 * One attempt per learner per step of the lab, from the records of that lab. The lab's own record
 * counts toward its first step. A record whose step the lab no longer has stays an attempt under the
 * lab, marked removed, so no history is lost when an author renames a step. Records of other labs
 * and courses, and records that name no lab (older rows of a course's route and a step id), are ignored.
 */
export function attemptsFromRecords(records: readonly LearningRecordRow[], lab: LabSteps): Attempt[] {
  const route = trimSlashes(lab.labRoute, false);
  const prefix = `${route}/`;
  const known = new Set(lab.stepIds);
  const attempts = new Map<string, Attempt>();
  for (const record of records) {
    if (record.course_id !== lab.courseId || !record.lo_id) continue;
    const loId = trimSlashes(record.lo_id, false);
    const stepId = loId === route ? lab.stepIds[0] : loId.startsWith(prefix) ? loId.slice(prefix.length) : undefined;
    if (!stepId || stepId.includes("/")) continue;
    const ref: StepRef = { courseId: lab.courseId, labRoute: lab.labRoute, stepId };
    const key = `${record.student_id}\t${stepKey(ref)}`;
    const seen = attempts.get(key);
    const visits = record.count ?? 0;
    const activeBlocks = record.duration ?? 0;
    if (seen) {
      seen.visits += visits;
      seen.activeBlocks += activeBlocks;
      seen.lastAt = later(seen.lastAt, record.date_last_accessed);
      continue;
    }
    attempts.set(key, { ref, learnerId: record.student_id, visits, activeBlocks, lastAt: record.date_last_accessed, removed: !known.has(stepId) });
  }
  return [...attempts.values()];
}
