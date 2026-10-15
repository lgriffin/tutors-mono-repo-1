/**
 * Shared types for the SCORM run-time environment. The versions are the course's vocabulary and
 * the summary is what the ScormRecords port keeps, so both come from the rings.
 */
import type { ScormVersion } from "@tutors/domain/course";
import type { ScormSummary } from "@tutors/application/ports";

export type { ScormVersion, ScormSummary };

/**
 * Where a learner's SCORM state lives between sessions.
 *
 * Implementations decide whether that is a database row or the browser; the run-time
 * neither knows nor cares. `save` is fire-and-forget because it is called from the SCO's
 * synchronous Commit and Terminate, which cannot wait for a round trip.
 */
export interface ScormStore {
  /** Previously saved CMI data, or an empty object for a first attempt. */
  load(): Record<string, string>;
  save(cmi: Record<string, string>, summary: ScormSummary): void;
}

export interface ScormApiOptions {
  version: ScormVersion;
  /** Reported to the SCO as `cmi.core.student_id` / `cmi.learner_id`. */
  learnerId: string;
  /** Reported to the SCO as `cmi.core.student_name` / `cmi.learner_name`. */
  learnerName: string;
  /** Pass mark declared by the learning object, if any. */
  masteryScore?: number;
  store: ScormStore;
}
