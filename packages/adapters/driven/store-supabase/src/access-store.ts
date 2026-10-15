/** Content locks in `tutors_content_locks`; `supabaseAccessStore` is the application's AccessStore over them. */
import type { ContentLock } from "@tutors/domain/access";
import type { AccessStore } from "@tutors/application/ports";
import log from "@tutors/logger";
import type { SupabaseClient } from "./client.ts";

export async function getLocksForCourse(courseId: string, client: SupabaseClient): Promise<ContentLock[]> {
  if (!courseId) return [];

  const { data, error } = await client
    .from("tutors_content_locks")
    .select("id, course_id, lo_route, locked, locked_by, locked_at")
    .eq("course_id", courseId);

  if (error) {
    log.error("getLocksForCourse failed:", error);
    return [];
  }

  return (data ?? []) as ContentLock[];
}

export async function upsertLock(courseId: string, loRoute: string, locked: boolean, lockedBy: string, client: SupabaseClient): Promise<boolean> {
  if (!courseId || !loRoute || !lockedBy) return false;

  const { error } = await client.from("tutors_content_locks").upsert(
    {
      course_id: courseId,
      lo_route: loRoute,
      locked,
      locked_by: lockedBy,
      locked_at: new Date().toISOString()
    },
    { onConflict: "course_id,lo_route" }
  );

  if (error) {
    log.error("upsertLock failed:", error);
    return false;
  }
  return true;
}

export async function removeLock(courseId: string, loRoute: string, client: SupabaseClient): Promise<boolean> {
  if (!courseId || !loRoute) return false;

  // Ask for the deleted rows back, so a delete that matched nothing answers false (the AccessStore contract).
  const { data, error } = await client.from("tutors_content_locks").delete().eq("course_id", courseId).eq("lo_route", loRoute).select("lo_route");

  if (error) {
    log.error("removeLock failed:", error);
    return false;
  }
  return (data?.length ?? 0) > 0;
}

/** The AccessStore over the reader server's service client: locks are read and changed only behind /api/locks. */
export function supabaseAccessStore(client: SupabaseClient): AccessStore {
  return {
    locks: (courseId) => getLocksForCourse(courseId, client),
    setLock: (courseId, loRoute, locked, lockedBy) => upsertLock(courseId, loRoute, locked, lockedBy, client),
    removeLock: (courseId, loRoute) => removeLock(courseId, loRoute, client)
  };
}
