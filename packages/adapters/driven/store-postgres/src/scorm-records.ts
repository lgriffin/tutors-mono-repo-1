/**
 * SCORM run-time state in `scorm_records`, one row per learner per learning object; `postgresScormRecords`
 * is the application's ScormRecords over it. The whole CMI data model is kept (the SCO reads its own
 * state back on resume) beside the columns Tutors reports on.
 */
import type { ScormRecords } from "@tutors/application/ports";
import log from "@tutors/logger";
import type { SqlClient } from "./client.ts";

/** ScormRecords for the reader's server (GET and PUT /api/scorm). Never throws: a failed save leaves the browser's copy as the record of the attempt. */
export function postgresScormRecords(sql: SqlClient): ScormRecords {
  return {
    async load(courseId, learnerId, loId) {
      if (!courseId || !learnerId || !loId) return {};
      try {
        const { rows } = await sql.query<{ cmi: Record<string, string> }>(`SELECT cmi FROM scorm_records WHERE course_id = $1 AND student_id = $2 AND lo_id = $3`, [courseId, learnerId, loId]);
        return rows[0]?.cmi ?? {};
      } catch (error) {
        log.error("getScormRecord failed:", error);
        return {};
      }
    },
    async save({ courseId, learnerId, loId, version, cmi, summary }) {
      if (!courseId || !learnerId || !loId) return;
      try {
        await sql.query(
          `INSERT INTO scorm_records (course_id, student_id, lo_id, scorm_version, cmi, completion_status, success_status, score_raw, score_max, score_scaled, total_time, updated_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, now())
           ON CONFLICT (student_id, course_id, lo_id) DO UPDATE SET
             scorm_version = EXCLUDED.scorm_version, cmi = EXCLUDED.cmi, completion_status = EXCLUDED.completion_status,
             success_status = EXCLUDED.success_status, score_raw = EXCLUDED.score_raw, score_max = EXCLUDED.score_max,
             score_scaled = EXCLUDED.score_scaled, total_time = EXCLUDED.total_time, updated_at = EXCLUDED.updated_at`,
          [
            courseId,
            learnerId,
            loId,
            version,
            JSON.stringify(cmi),
            summary.completionStatus,
            summary.successStatus,
            summary.scoreRaw ?? null,
            summary.scoreMax ?? null,
            summary.scoreScaled ?? null,
            summary.totalTime
          ]
        );
      } catch (error) {
        log.error("upsertScormRecord failed:", error);
      }
    }
  };
}
