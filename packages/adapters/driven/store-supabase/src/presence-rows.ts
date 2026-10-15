/**
 * The latest presence snapshot per learner per course (`tutors-connect-latest`), as the live
 * app reads it and the reader's server writes it (POST /api/presence, for the session's login).
 * The reader's own roster reads go through the realtime adapter's PresencePort.
 */
import type { TutorsConnectLatestRow } from "@tutors/domain/learning";
import log from "@tutors/logger";
import { fail, supabase, type SupabaseClient } from "./client.ts";

/** The server's write: the snapshot of `login` in `courseId`, whatever the payload names. */
export async function upsertLatest(db: SupabaseClient, login: string, courseId: string, payload: unknown, now: Date = new Date()): Promise<void> {
  const { error } = await db
    .from("tutors-connect-latest")
    .upsert({ course_id: courseId, student_id: login, payload, received_at: now.toISOString() }, { onConflict: "course_id,student_id" });
  if (error) fail("tutors-connect-latest upsert", error);
}

/**
 * Upsert latest Lo snapshot for (course, student) into tutors-connect-latest.
 * Fire-and-forget from presence; does not throw.
 */
export async function upsertTutorsConnectLatestLo(loRecord: object, client: SupabaseClient | undefined = supabase): Promise<void> {
  if (!client) return;

  const rec = loRecord as { courseId?: string; user?: { id?: string } };
  const courseId = rec.courseId?.trim();
  const studentId = rec.user?.id?.trim();
  if (!courseId || !studentId) return;

  try {
    await upsertLatest(client, studentId, courseId, loRecord);
  } catch (error) {
    log.error("upsertTutorsConnectLatestLo failed:", error);
  }
}

/**
 * All stored Lo snapshots for a course (one row per student, already “latest” by key).
 * Sorted by `received_at` descending (most recently updated first).
 */
export async function getTutorsConnectLatestLosByCourseId(courseId: string): Promise<TutorsConnectLatestRow[]> {
  if (!supabase) return [];

  const id = courseId?.trim();
  if (!id) return [];

  const { data, error } = await supabase
    .from("tutors-connect-latest")
    .select("course_id, student_id, payload, received_at")
    .eq("course_id", id)
    .order("received_at", { ascending: false });

  if (error) {
    log.error("getTutorsConnectLatestLosByCourseId failed:", error);
    return [];
  }

  return (data ?? []) as TutorsConnectLatestRow[];
}

/**
 * Stored Lo snapshots for a course received at or after `sinceIso`: the students active recently.
 * Sorted by `received_at` descending (most recently updated first).
 * @returns null when the read fails, so a caller can tell a failure from a course nobody is in
 */
export async function getTutorsConnectRecentLosByCourseId(courseId: string, sinceIso: string): Promise<TutorsConnectLatestRow[] | null> {
  if (!supabase) return [];

  const id = courseId?.trim();
  if (!id) return [];

  const { data, error } = await supabase
    .from("tutors-connect-latest")
    .select("course_id, student_id, payload, received_at")
    .eq("course_id", id)
    .gte("received_at", sinceIso)
    .order("received_at", { ascending: false });

  if (error) {
    log.error("getTutorsConnectRecentLosByCourseId failed:", error);
    return null;
  }

  return (data ?? []) as TutorsConnectLatestRow[];
}
