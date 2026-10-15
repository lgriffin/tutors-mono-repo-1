/**
 * The catalogue's record of each published course (`tutors-connect-courses`): how often it was
 * visited and the card the catalogue shows. Written by the reader's server (POST /api/courses/visit)
 * with the title, credits and privacy it read from the published course, never from the browser.
 */
import { fail, type SupabaseClient } from "./client.ts";

/** Counts a visit to `courseId` and stores `record` as its card. */
export async function recordCourseVisit(db: SupabaseClient, courseId: string, record: Record<string, unknown>, now: Date = new Date()): Promise<void> {
  const { data, error } = await db.from("tutors-connect-courses").select("visit_count").eq("course_id", courseId).maybeSingle();
  if (error) fail("tutors-connect-courses read", error);
  const visits = ((data as { visit_count?: number } | null)?.visit_count ?? 0) + 1;
  const { error: upsertError } = await db
    .from("tutors-connect-courses")
    .upsert({ course_id: courseId, visited_at: now.toISOString(), visit_count: visits, course_record: record }, { onConflict: "course_id" });
  if (upsertError) fail("tutors-connect-courses upsert", upsertError);
}
