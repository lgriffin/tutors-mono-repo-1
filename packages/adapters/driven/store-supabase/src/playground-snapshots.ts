/**
 * Playground snapshots in `playground_snapshots`: the only part of a playground that leaves the browser.
 * The reader's server reads and writes them with its service client for GET, PUT and DELETE
 * /api/playground, after deciding from the session who may see which row (a student their own, an
 * educator of the course every one, Rule 0475); the browser reaches them only through that route.
 */
import { SNAPSHOT_OUTPUT_LIMIT, type PlaygroundSnapshot } from "@tutors/application/ports";
import { fail, type SupabaseClient } from "./client.ts";

interface SnapshotRow {
  student_id: string;
  student_name: string | null;
  course_id: string;
  lo_id: string;
  runtime: string;
  entry: string;
  files: PlaygroundSnapshot["files"] | null;
  last_output: string | null;
  last_ok: boolean | null;
  updated_at: string;
}

function toSnapshot(row: SnapshotRow): PlaygroundSnapshot {
  return {
    studentId: row.student_id,
    studentName: row.student_name ?? row.student_id,
    courseId: row.course_id,
    loId: row.lo_id,
    runtime: row.runtime,
    entry: row.entry,
    files: row.files ?? [],
    lastOutput: row.last_output ?? "",
    lastOk: row.last_ok,
    updatedAt: row.updated_at
  };
}

/** The snapshots the server reads and writes; the route has already decided whose rows the caller may touch. */
export interface PlaygroundSnapshotRows {
  save(snapshot: Omit<PlaygroundSnapshot, "updatedAt">): Promise<void>;
  /** One exercise's snapshots, newest first: every student's, or only `studentId`'s. */
  list(courseId: string, loId: string, studentId: string | null): Promise<PlaygroundSnapshot[]>;
  remove(courseId: string, loId: string, studentId: string): Promise<void>;
}

export function supabasePlaygroundSnapshotRows(db: SupabaseClient): PlaygroundSnapshotRows {
  return {
    async save(snapshot) {
      const { error } = await db.from("playground_snapshots").upsert(
        {
          student_id: snapshot.studentId,
          student_name: snapshot.studentName,
          course_id: snapshot.courseId,
          lo_id: snapshot.loId,
          runtime: snapshot.runtime,
          entry: snapshot.entry,
          files: snapshot.files,
          last_output: snapshot.lastOutput.slice(0, SNAPSHOT_OUTPUT_LIMIT),
          last_ok: snapshot.lastOk,
          updated_at: new Date().toISOString()
        },
        { onConflict: "student_id, course_id, lo_id" }
      );
      if (error) fail("playground_snapshots upsert", error);
    },

    async list(courseId, loId, studentId) {
      let query = db.from("playground_snapshots").select("*").eq("course_id", courseId).eq("lo_id", loId);
      if (studentId) query = query.eq("student_id", studentId);
      const { data, error } = await query.order("updated_at", { ascending: false });
      if (error) fail("playground_snapshots select", error);
      return ((data ?? []) as SnapshotRow[]).map(toSnapshot);
    },

    async remove(courseId, loId, studentId) {
      const { error } = await db.from("playground_snapshots").delete().eq("course_id", courseId).eq("lo_id", loId).eq("student_id", studentId);
      if (error) fail("playground_snapshots delete", error);
    }
  };
}
