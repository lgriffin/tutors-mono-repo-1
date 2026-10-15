/**
 * Learning records in Postgres: a page load and a 30-second tick, each one statement, as the
 * Supabase functions record_page_view and record_heartbeat do (supabase/migrations/
 * 20261014_record_page_view_and_heartbeat.sql). The reader's server writes them for the login its
 * session verified (Rule 0072); `postgresLearningEventSink` is the application's LearningEventSink.
 */
import type { LearningEventSink } from "@tutors/application/ports";
import { run, type SqlClient } from "./client.ts";

/** One visit and one 30-second block on the learning object, one page load and one block on the day. */
const PAGE_VIEW = `
WITH visit AS (
  INSERT INTO learning_records (course_id, student_id, lo_id, duration, count, date_last_accessed, type)
  VALUES ($1, $2, $3, 1, 1, now(), $4)
  ON CONFLICT (student_id, course_id, lo_id) DO UPDATE
    SET duration = COALESCE(learning_records.duration, 0) + 1,
        count = COALESCE(learning_records.count, 0) + 1,
        date_last_accessed = now(),
        type = EXCLUDED.type
)
INSERT INTO calendar (id, studentid, courseid, timeactive, pageloads)
VALUES ($5::date, $2, $1, 1, 1)
ON CONFLICT (id, studentid, courseid) DO UPDATE
  SET timeactive = COALESCE(calendar.timeactive, 0) + 1,
      pageloads = COALESCE(calendar.pageloads, 0) + 1`;

/** One more 30-second block on the learning object (when there is one) and on the day, for rows a page load made. */
const HEARTBEAT = `
WITH lo AS (
  UPDATE learning_records
    SET duration = COALESCE(duration, 0) + 1
    WHERE $3::text IS NOT NULL AND course_id = $1 AND student_id = $2 AND lo_id = $3
)
UPDATE calendar
  SET timeactive = COALESCE(timeactive, 0) + 1
  WHERE id = $4::date AND studentid = $2 AND courseid = $1`;

/** A learner opened a learning object on `day`. */
function recordPageLoad(sql: SqlClient, login: string, input: { courseId: string; loId: string; loType: string; day: string }): Promise<unknown> {
  return run("record page view", () => sql.query(PAGE_VIEW, [input.courseId, login, input.loId, input.loType, input.day]));
}

/** Thirty seconds of activity against the learning object (when there is one) and the day's calendar. */
function recordTick(sql: SqlClient, login: string, input: { courseId: string; loId: string | null; day: string }): Promise<unknown> {
  return run("record heartbeat", () => sql.query(HEARTBEAT, [input.courseId, login, input.loId, input.day]));
}

export function postgresLearningEventSink(sql: SqlClient): LearningEventSink {
  return {
    async record(event, learnerId) {
      if (!learnerId || !event.courseId) return;
      if (event.kind === "page-load") {
        if (!event.loId) return;
        await recordPageLoad(sql, learnerId, { courseId: event.courseId, loId: event.loId, loType: event.loType, day: event.day });
      } else {
        await recordTick(sql, learnerId, { courseId: event.courseId, loId: event.loId, day: event.day });
      }
    }
  };
}
