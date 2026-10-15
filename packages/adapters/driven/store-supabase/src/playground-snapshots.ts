/**
 * Playground snapshots in `playground_snapshots`: the only part of a playground that leaves the browser.
 * `supabasePlaygroundSnapshots` is the application's PlaygroundSnapshots over it.
 *
 * A snapshot is written with an authenticated client rather than the anon one the rest of this adapter
 * uses. The rows have an owner and the policies on the table are written against the token's claims
 * (supabase/migrations/20261018000200_create_playground_snapshots.sql), so the token is not decoration:
 * without it every request is rejected. The reader mints it from the signed-in session
 * (GET /api/runtime-token); a deployment with no JWT secret answers 501 and the feature is simply
 * not available there.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SNAPSHOT_OUTPUT_LIMIT, type PlaygroundSnapshot, type PlaygroundSnapshots } from "@tutors/application/ports";
import log from "@tutors/logger";

/** The reader endpoint that turns a signed-in session into a Supabase token. */
export const RUNTIME_TOKEN_ROUTE = "/api/runtime-token";

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

/** The claims of a minted token, read without verifying it: the database verifies; this only decides what the page offers. */
function claimsOf(token: string): { educator_courses?: unknown } {
  try {
    return JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return {};
  }
}

export type SupabasePlaygroundSnapshotsOptions = {
  /** The project the composition root configured; without one nothing is available. */
  url: string | undefined;
  key: string | undefined;
  /** How a token is asked for; the default fetches RUNTIME_TOKEN_ROUTE with the browser's cookies. */
  fetchFn?: typeof fetch;
  /** The client built for a token; the default is a real client carrying it on every request. */
  clientFor?: (token: string) => SupabaseClient;
};

export function supabasePlaygroundSnapshots(options: SupabasePlaygroundSnapshotsOptions): PlaygroundSnapshots {
  const { url, key } = options;
  const fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
  const clientFor =
    options.clientFor ??
    ((token: string) =>
      // The token rides on the Authorization header of every request this client makes,
      // which is what `auth.jwt()` reads on the other end.
      createClient(url!, key!, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false } }));

  let cached: { token: string; courseId: string; expiresAt: number; client: SupabaseClient } | null = null;

  /**
   * A client that acts as the signed-in student, or null whenever that is not possible: signed out,
   * Supabase not configured, or a reader deployment with no JWT secret. Null means "not available
   * here" rather than an error, because for most deployments it is not.
   */
  async function authedClient(courseId: string): Promise<SupabaseClient | null> {
    if (!url || !key) return null;
    if (cached && cached.courseId === courseId && cached.expiresAt > Date.now() + 30_000) return cached.client;
    try {
      const response = await fetchFn(`${RUNTIME_TOKEN_ROUTE}?courseId=${encodeURIComponent(courseId)}`);
      if (!response.ok) return null;
      const { token, expiresIn } = (await response.json()) as { token: string; expiresIn: number };
      const client = clientFor(token);
      cached = { token, courseId, expiresAt: Date.now() + expiresIn * 1000, client };
      return client;
    } catch (error) {
      log.error("playground token request failed:", error);
      return null;
    }
  }

  return {
    async available(courseId) {
      return (await authedClient(courseId)) !== null;
    },

    async reviews(courseId) {
      const client = await authedClient(courseId);
      if (!client || !cached) return false;
      const courses = claimsOf(cached.token).educator_courses;
      return Array.isArray(courses) && courses.includes(courseId);
    },

    async save(snapshot) {
      const client = await authedClient(snapshot.courseId);
      if (!client) return false;
      if (!snapshot.courseId || !snapshot.loId || !snapshot.studentId) return false;
      const { error } = await client.from("playground_snapshots").upsert(
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
      if (error) {
        log.error("savePlaygroundSnapshot failed:", error);
        return false;
      }
      return true;
    },

    async get(courseId, loId, studentId) {
      const client = await authedClient(courseId);
      if (!client) return null;
      const { data, error } = await client.from("playground_snapshots").select("*").eq("course_id", courseId).eq("lo_id", loId).eq("student_id", studentId).maybeSingle();
      if (error) {
        log.error("getPlaygroundSnapshot failed:", error);
        return null;
      }
      return data ? toSnapshot(data as SnapshotRow) : null;
    },

    /** Returns a student's own row at most: the same query runs, and row-level security answers it. */
    async list(courseId, loId) {
      const client = await authedClient(courseId);
      if (!client) return [];
      const { data, error } = await client.from("playground_snapshots").select("*").eq("course_id", courseId).eq("lo_id", loId).order("updated_at", { ascending: false });
      if (error) {
        log.error("listPlaygroundSnapshots failed:", error);
        return [];
      }
      return ((data ?? []) as SnapshotRow[]).map(toSnapshot);
    },

    async remove(courseId, loId, studentId) {
      const client = await authedClient(courseId);
      if (!client) return;
      const { error } = await client.from("playground_snapshots").delete().eq("course_id", courseId).eq("lo_id", loId).eq("student_id", studentId);
      if (error) log.error("removePlaygroundSnapshot failed:", error);
    }
  };
}
