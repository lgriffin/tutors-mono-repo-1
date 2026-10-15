/**
 * Playground snapshots in `playground_snapshots`: the only part of a playground that leaves the
 * browser. The reader's server reads and writes them for GET, PUT and DELETE /api/playground, after
 * deciding from the session who may see which row (Rule 0475).
 */
import { SNAPSHOT_OUTPUT_LIMIT, type PlaygroundSnapshot } from "@tutors/application/ports";
import { iso, run, type SqlClient } from "./client.ts";

/** The snapshots the server reads and writes; the route has already decided whose rows the caller may touch. */
export interface PlaygroundSnapshotRows {
  save(snapshot: Omit<PlaygroundSnapshot, "updatedAt">): Promise<void>;
  /** One exercise's snapshots, newest first: every student's, or only `studentId`'s. */
  list(courseId: string, loId: string, studentId: string | null): Promise<PlaygroundSnapshot[]>;
  remove(courseId: string, loId: string, studentId: string): Promise<void>;
}

export function postgresPlaygroundSnapshotRows(sql: SqlClient): PlaygroundSnapshotRows {
  return {
    async save(s) {
      await run("playground_snapshots upsert", () =>
        sql.query(
          `INSERT INTO playground_snapshots (student_id, student_name, course_id, lo_id, runtime, entry, files, last_output, last_ok, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, now())
           ON CONFLICT (student_id, course_id, lo_id) DO UPDATE SET
             student_name = EXCLUDED.student_name, runtime = EXCLUDED.runtime, entry = EXCLUDED.entry, files = EXCLUDED.files,
             last_output = EXCLUDED.last_output, last_ok = EXCLUDED.last_ok, updated_at = EXCLUDED.updated_at`,
          [s.studentId, s.studentName, s.courseId, s.loId, s.runtime, s.entry, JSON.stringify(s.files), s.lastOutput.slice(0, SNAPSHOT_OUTPUT_LIMIT), s.lastOk]
        )
      );
    },
    async list(courseId, loId, studentId) {
      const { rows } = await run("playground_snapshots select", () =>
        sql.query(
          `SELECT * FROM playground_snapshots WHERE course_id = $1 AND lo_id = $2 AND ($3::text IS NULL OR student_id = $3) ORDER BY updated_at DESC`,
          [courseId, loId, studentId]
        )
      );
      return rows.map((r) => ({
        studentId: r.student_id as string,
        studentName: (r.student_name as string | null) ?? (r.student_id as string),
        courseId: r.course_id as string,
        loId: r.lo_id as string,
        runtime: r.runtime as string,
        entry: r.entry as string,
        files: (r.files as PlaygroundSnapshot["files"] | null) ?? [],
        lastOutput: (r.last_output as string | null) ?? "",
        lastOk: (r.last_ok as boolean | null) ?? null,
        updatedAt: iso(r.updated_at) as string
      }));
    },
    async remove(courseId, loId, studentId) {
      await run("playground_snapshots delete", () => sql.query(`DELETE FROM playground_snapshots WHERE course_id = $1 AND lo_id = $2 AND student_id = $3`, [courseId, loId, studentId]));
    }
  };
}
