/**
 * The latest presence snapshot per learner per course (`tutors-connect-latest`), as the reader's
 * server writes it (POST /api/presence, for the session's login) and reads it for the roster
 * (GET /api/presence/roster).
 */
import type { TutorsConnectLatestRow } from "@tutors/domain/learning";
import log from "@tutors/logger";
import { iso, run, type SqlClient } from "./client.ts";

/** The server's write: the snapshot of `login` in `courseId`, whatever the payload names. */
export async function upsertLatest(sql: SqlClient, login: string, courseId: string, payload: unknown, now: Date = new Date()): Promise<void> {
  await run("tutors-connect-latest upsert", () =>
    sql.query(
      `INSERT INTO "tutors-connect-latest" (course_id, student_id, payload, received_at) VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (course_id, student_id) DO UPDATE SET payload = EXCLUDED.payload, received_at = EXCLUDED.received_at`,
      [courseId, login, JSON.stringify(payload ?? {}), now.toISOString()]
    )
  );
}

/**
 * The stored snapshots received at or after `sinceIso` (every one when it is null), most recent first:
 * one course's, or the most recent 200 across every course when `courseId` is null.
 * @returns null when the read fails, so a caller can tell a failure from a course nobody is in
 */
export async function readRoster(sql: SqlClient, courseId: string | null, sinceIso: string | null): Promise<TutorsConnectLatestRow[] | null> {
  try {
    const { rows } = await sql.query(
      `SELECT course_id, student_id, payload, received_at FROM "tutors-connect-latest"
       WHERE ($1::text IS NULL OR course_id = $1) AND ($2::timestamptz IS NULL OR received_at >= $2::timestamptz)
       ORDER BY received_at DESC LIMIT CASE WHEN $1::text IS NULL THEN 200 END`,
      [courseId, sinceIso]
    );
    return rows.map((r) => ({ ...r, received_at: iso(r.received_at) }) as TutorsConnectLatestRow);
  } catch (error) {
    log.error("Reading the presence roster failed:", error);
    return null;
  }
}
