/**
 * Learning records in Supabase: page views and heartbeats, as the single-request functions of
 * supabase/migrations/20261014_record_page_view_and_heartbeat.sql write them, with the per-table
 * requests as the fallback until that migration is applied. The reader's server writes them with
 * its service client for the login its session verified (Rule 0072); `supabaseLearningEventSink`
 * is the application's LearningEventSink over these.
 */
import { localYyyyMmDd } from "@tutors/domain/learning";
import type { LearningEventSink } from "@tutors/application/ports";
import log from "@tutors/logger";
import { fail, type SupabaseClient } from "./client.ts";

/** Formats a date as the calendar's `YYYY-MM-DD` day, in local time. */
export function formatDate(date: Date): string {
  return localYyyyMmDd(new Date(date));
}

/** PostgREST's code for a function its schema cache does not hold: the migration is not applied yet. */
const MISSING_FUNCTION = "PGRST202";
/**
 * Both functions ship in one migration, so once the database answers that one is missing, this
 * process uses the per-table requests until it restarts, without asking again.
 */
export const recordingFunctions = { missing: false };

/**
 * Calls one of the single-request recording functions. Each replaces several read-then-write
 * requests with one atomic write.
 * @returns true when the write is done; false when the caller should use the per-table requests
 */
async function callRecordingFunction(db: SupabaseClient, fn: "record_page_view" | "record_heartbeat", args: Record<string, unknown>): Promise<boolean> {
  if (recordingFunctions.missing) return false;
  const { error } = await db.rpc(fn, args);
  if (!error) return true;
  if (error.code === MISSING_FUNCTION) {
    recordingFunctions.missing = true;
    log.warn("Single-request recording functions are missing; using per-table requests");
    return false;
  }
  fail(fn, error);
}

async function nextIncrement(db: SupabaseClient, field: "duration" | "count", courseId: string, login: string, loId: string): Promise<number> {
  const { data, error } = await db.rpc("get_count_learning_records", {
    field_name: field,
    course_base: courseId,
    user_name: login,
    lo_key: loId
  });
  if (error) fail("get_count_learning_records", error);
  // No record yet comes back as an empty array, not null: the first visit counts as 1.
  return ((data as { increment?: number }[] | null)?.[0]?.increment ?? 0) + 1;
}

async function nextCalendarValue(db: SupabaseClient, column: "timeactive" | "pageloads", day: string, login: string, courseId: string): Promise<number> {
  const { data, error } = await db.from("calendar").select(column).eq("id", day).eq("studentid", login).eq("courseid", courseId).maybeSingle();
  if (error) fail("calendar read", error);
  const current = (data as Record<string, number | null> | null)?.[column];
  return current ? current + 1 : 1;
}

/** A learner opened a learning object on `day`: one request where the recording functions exist, the per-table requests otherwise. */
export async function recordPageLoad(db: SupabaseClient, login: string, input: { courseId: string; loId: string; loType: string; day: string }): Promise<void> {
  if (
    await callRecordingFunction(db, "record_page_view", {
      p_course_id: input.courseId,
      p_student_id: login,
      p_lo_id: input.loId,
      p_lo_type: input.loType,
      p_day: input.day
    })
  )
    return;
  const [duration, count] = await Promise.all([nextIncrement(db, "duration", input.courseId, login, input.loId), nextIncrement(db, "count", input.courseId, login, input.loId)]);
  const { error } = await db.from("learning_records").upsert(
    {
      course_id: input.courseId,
      student_id: login,
      lo_id: input.loId,
      date_last_accessed: new Date().toISOString(),
      duration,
      count,
      type: input.loType
    },
    { onConflict: "student_id, course_id, lo_id", ignoreDuplicates: false }
  );
  if (error) fail("learning_records upsert", error);

  const [timeactive, pageloads] = await Promise.all([
    nextCalendarValue(db, "timeactive", input.day, login, input.courseId),
    nextCalendarValue(db, "pageloads", input.day, login, input.courseId)
  ]);
  const { error: calendarError } = await db
    .from("calendar")
    .upsert({ id: input.day, studentid: login, timeactive, pageloads, courseid: input.courseId }, { onConflict: "id, studentid, courseid" });
  if (calendarError) fail("calendar upsert", calendarError);
}

/** Thirty seconds of activity against the learning object (when there is one) and the day's calendar. */
export async function recordTick(db: SupabaseClient, login: string, input: { courseId: string; loId: string | null; day: string }): Promise<void> {
  if (
    await callRecordingFunction(db, "record_heartbeat", {
      p_course_id: input.courseId,
      p_student_id: login,
      p_lo_id: input.loId,
      p_day: input.day
    })
  )
    return;
  if (input.loId) {
    const duration = await nextIncrement(db, "duration", input.courseId, login, input.loId);
    const { error } = await db.from("learning_records").update({ duration }).eq("student_id", login).eq("course_id", input.courseId).eq("lo_id", input.loId);
    if (error) fail("learning_records update", error);
  }
  const { error } = await db.rpc("increment_calendar", {
    field_name: "timeactive",
    row_id: input.day,
    student_id_value: login,
    course_id_value: input.courseId
  });
  if (error) fail("increment_calendar", error);
}

/** The application's LearningEventSink over the recording functions above; nothing is recorded without a client. */
export function supabaseLearningEventSink(client?: SupabaseClient): LearningEventSink {
  return {
    async record(event, learnerId) {
      const db = client;
      if (!db || !learnerId || !event.courseId) return;
      if (event.kind === "page-load") {
        if (!event.loId) return;
        await recordPageLoad(db, learnerId, { courseId: event.courseId, loId: event.loId, loType: event.loType, day: event.day });
      } else {
        await recordTick(db, learnerId, { courseId: event.courseId, loId: event.loId, day: event.day });
      }
    }
  };
}
