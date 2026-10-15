/**
 * Tutors Time's cache of Moodle assignments and submissions in `assignments` and
 * `assignments_submissions`: the writes of the time app's Moodle sync, so that on DATA_STORE=postgres
 * the sync fills the same tables the reader's `timeRows` reads. Rows are the shapes the sync builds
 * for the Supabase upserts; a row already there (by `id`) is replaced.
 */
import { run, type SqlClient } from "./client.ts";

export interface AssignmentRow {
  courseid: string;
  id: number;
  name: string | null;
  url: string | null;
  due_date: string | null;
  opened_date: string | null;
  last_synced_at: string;
}

export interface SubmissionRow {
  id: number;
  assignmentId: number;
  external_userid: number;
  attempt_no: number;
  status: string;
  timecreated: string | null;
  timemodified: string | null;
  timestarted: string | null;
  grading_status: string;
  last_synced_at: string;
}

export function postgresAssignmentRows(sql: SqlClient) {
  return {
    /** When `courseId`'s assignments were last synced, or null when they never were. */
    async lastSyncedAt(courseId: string): Promise<string | null> {
      const { rows } = await run("assignments read", () =>
        sql.query<{ last_synced_at: unknown }>(`SELECT max(last_synced_at) AS last_synced_at FROM assignments WHERE courseid = $1`, [courseId])
      );
      const at = rows[0]?.last_synced_at;
      return at === null || at === undefined ? null : new Date(at as string).toISOString();
    },
    async upsertAssignments(rows: AssignmentRow[]): Promise<void> {
      if (rows.length === 0) return;
      await run("assignments upsert", () =>
        sql.query(
          `INSERT INTO assignments (id, courseid, name, url, due_date, opened_date, last_synced_at)
           SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(id bigint, courseid text, name text, url text, due_date timestamptz, opened_date timestamptz, last_synced_at timestamptz)
           ON CONFLICT (id) DO UPDATE SET courseid = EXCLUDED.courseid, name = EXCLUDED.name, url = EXCLUDED.url,
             due_date = EXCLUDED.due_date, opened_date = EXCLUDED.opened_date, last_synced_at = EXCLUDED.last_synced_at`,
          [JSON.stringify(rows)]
        )
      );
    },
    async upsertSubmissions(rows: SubmissionRow[]): Promise<void> {
      if (rows.length === 0) return;
      await run("assignments_submissions upsert", () =>
        sql.query(
          `INSERT INTO assignments_submissions (id, "assignmentId", external_userid, attempt_no, status, timecreated, timemodified, timestarted, grading_status, last_synced_at)
           SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(id bigint, "assignmentId" bigint, external_userid bigint, attempt_no integer, status text,
             timecreated timestamptz, timemodified timestamptz, timestarted timestamptz, grading_status text, last_synced_at timestamptz)
           ON CONFLICT (id) DO UPDATE SET "assignmentId" = EXCLUDED."assignmentId", external_userid = EXCLUDED.external_userid,
             attempt_no = EXCLUDED.attempt_no, status = EXCLUDED.status, timecreated = EXCLUDED.timecreated, timemodified = EXCLUDED.timemodified,
             timestarted = EXCLUDED.timestarted, grading_status = EXCLUDED.grading_status, last_synced_at = EXCLUDED.last_synced_at`,
          [JSON.stringify(rows)]
        )
      );
    }
  };
}
