import type { ScormVersion } from "@tutors/domain/course";

/**
 * The part of a SCO's state that Tutors cares about.
 *
 * The full CMI model is round-tripped verbatim so the SCO resumes exactly as it left off, but
 * only these fields are meaningful to Tutors itself: they are what a report is built from.
 */
export type ScormSummary = {
  /** "completed", "incomplete", "not attempted" or "unknown". */
  completionStatus: string;
  /** "passed", "failed" or "unknown". */
  successStatus: string;
  scoreRaw?: number;
  scoreMin?: number;
  scoreMax?: number;
  /** 0..1, SCORM 2004 only. */
  scoreScaled?: number;
  /** Accumulated seconds across every session. */
  totalTime: number;
  /** The SCO's own bookmark, replayed to it on resume. */
  location: string;
};

/** A learner's attempt at one imported SCORM package: the whole CMI data model plus what Tutors reports on. */
export type ScormRecord = {
  courseId: string;
  learnerId: string;
  loId: string;
  version: ScormVersion;
  cmi: Record<string, string>;
  summary: ScormSummary;
};

/** Keeps each learner's SCORM run-time state so an imported package resumes where it left off, on any device. */
export interface ScormRecords {
  /** The stored CMI data model, or an empty object for a first attempt. */
  load(courseId: string, learnerId: string, loId: string): Promise<Record<string, string>>;
  /** Never throws: a failed save leaves the browser-local copy as the record of the attempt. */
  save(record: ScormRecord): Promise<void>;
}
