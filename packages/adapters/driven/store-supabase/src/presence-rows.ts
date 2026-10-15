/**
 * The latest presence snapshot per learner per course (`tutors-connect-latest`), as the reader's
 * server writes it (POST /api/presence, for the session's login) and reads it for the roster
 * (GET /api/presence/roster). Browsers, Tutors Live's included, read it only through that route.
 */
import type { TutorsConnectLatestRow } from "@tutors/domain/learning";
import log from "@tutors/logger";
import { fail, type SupabaseClient } from "./client.ts";

/** The server's write: the snapshot of `login` in `courseId`, whatever the payload names. */
export async function upsertLatest(db: SupabaseClient, login: string, courseId: string, payload: unknown, now: Date = new Date()): Promise<void> {
  const { error } = await db
    .from("tutors-connect-latest")
    .upsert({ course_id: courseId, student_id: login, payload, received_at: now.toISOString() }, { onConflict: "course_id,student_id" });
  if (error) fail("tutors-connect-latest upsert", error);
}

/**
 * The stored snapshots received at or after `sinceIso` (every one when it is null), most recent first:
 * one course's, or the most recent 200 across every course when `courseId` is null.
 * @returns null when the read fails, so a caller can tell a failure from a course nobody is in
 */
export async function readRoster(db: SupabaseClient, courseId: string | null, sinceIso: string | null): Promise<TutorsConnectLatestRow[] | null> {
  let query = db.from("tutors-connect-latest").select("course_id, student_id, payload, received_at").order("received_at", { ascending: false });
  if (sinceIso) query = query.gte("received_at", sinceIso);
  query = courseId ? query.eq("course_id", courseId) : query.limit(200);
  const { data, error } = await query;
  if (error) {
    log.error("Reading the presence roster failed:", error);
    return null;
  }
  return (data ?? []) as TutorsConnectLatestRow[];
}
