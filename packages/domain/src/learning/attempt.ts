/**
 * A learner's attempts at the steps of a lab, read from the learning records the reader already
 * stores (Rule 0376): there is no attempts table. A step's records sit under the lab's record
 * route with the step id appended (`learningObjectRoute`), so the step is the last segment.
 */
import type { LearningRecordRow } from "./rows.ts";
import { trimSlashes, type StepRef } from "./step-ref.ts";

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

/** The lab the attempts are read for: where it lives in the reader, where its records live, its steps today. */
export type LabSteps = {
  courseId: string;
  labRoute: string;
  /** The prefix the lab's step records carry before the step id. */
  recordRoute: string;
  stepIds: readonly string[];
};

/**
 * One attempt per learner per step of the lab, from the records of that lab. A record whose step
 * the lab no longer has stays an attempt under the lab, marked removed, so no history is lost when
 * an author renames a step. Records of other labs and courses are ignored.
 */
export function attemptsFromRecords(records: readonly LearningRecordRow[], lab: LabSteps): Attempt[] {
  const prefix = `${trimSlashes(lab.recordRoute, false)}/`;
  const known = new Set(lab.stepIds);
  const attempts: Attempt[] = [];
  for (const record of records) {
    if (record.course_id !== lab.courseId || !record.lo_id?.startsWith(prefix)) continue;
    const stepId = record.lo_id.slice(prefix.length);
    if (!stepId || stepId.includes("/")) continue;
    attempts.push({
      ref: { courseId: lab.courseId, labRoute: lab.labRoute, stepId },
      learnerId: record.student_id,
      visits: record.count ?? 0,
      activeBlocks: record.duration ?? 0,
      lastAt: record.date_last_accessed,
      removed: !known.has(stepId)
    });
  }
  return attempts;
}
