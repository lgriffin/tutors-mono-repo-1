/**
 * SCORM run-time state in `scorm_records`, one row per learner per learning object; `supabaseScormRecords`
 * is the application's ScormRecords over it. Tutors plays the LMS role for a SCO, so the whole CMI data
 * model is kept (the SCO reads its own state back on resume) beside the columns Tutors reports on.
 */
import type { ScormRecord, ScormRecords } from "@tutors/application/ports";
import log from "@tutors/logger";
import { supabase } from "./client.ts";

/** A learner's saved SCORM state, so a SCO can resume where it left off; empty for a first attempt. */
export async function getScormRecord(courseId: string, studentId: string, loId: string): Promise<Record<string, string>> {
  if (!supabase) return {};
  if (!courseId || !studentId || !loId) return {};

  const { data, error } = await supabase.from("scorm_records").select("cmi").eq("course_id", courseId).eq("student_id", studentId).eq("lo_id", loId).maybeSingle();

  if (error) {
    log.error("getScormRecord failed:", error);
    return {};
  }
  return ((data as { cmi: Record<string, string> } | null)?.cmi ?? {}) as Record<string, string>;
}

/**
 * Stores a learner's SCORM state. Called from the SCO's own Commit and Terminate, which are synchronous
 * and cannot wait for a round trip, so this never throws: a failed save leaves the browser-local copy
 * as the record of the attempt.
 */
export async function upsertScormRecord(record: ScormRecord): Promise<void> {
  if (!supabase) return;
  const { courseId, learnerId, loId, version, cmi, summary } = record;
  if (!courseId || !learnerId || !loId) return;

  const { error } = await supabase.from("scorm_records").upsert(
    {
      course_id: courseId,
      student_id: learnerId,
      lo_id: loId,
      scorm_version: version,
      cmi,
      completion_status: summary.completionStatus,
      success_status: summary.successStatus,
      score_raw: summary.scoreRaw ?? null,
      score_max: summary.scoreMax ?? null,
      score_scaled: summary.scoreScaled ?? null,
      total_time: summary.totalTime,
      updated_at: new Date().toISOString()
    },
    { onConflict: "student_id, course_id, lo_id" }
  );

  if (error) {
    log.error("upsertScormRecord failed:", error);
  }
}

export function supabaseScormRecords(): ScormRecords {
  return { load: getScormRecord, save: upsertScormRecord };
}
