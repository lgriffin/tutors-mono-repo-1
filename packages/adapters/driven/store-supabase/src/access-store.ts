/** Content locks in `tutors_content_locks`; `supabaseAccessStore` is the application's AccessStore over them. */
import type { ContentLock } from "@tutors/domain/access";
import type { AccessStore } from "@tutors/application/ports";
import log from "@tutors/logger";
import { supabase, type SupabaseClient } from "./client.ts";

export async function getLocksForCourse(courseId: string, client: SupabaseClient | undefined = supabase): Promise<ContentLock[]> {
  if (!client) return [];
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

export async function upsertLock(courseId: string, loRoute: string, locked: boolean, lockedBy: string, client: SupabaseClient | undefined = supabase): Promise<boolean> {
  if (!client) return false;
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

export async function removeLock(courseId: string, loRoute: string, client: SupabaseClient | undefined = supabase): Promise<boolean> {
  if (!client) return false;
  if (!courseId || !loRoute) return false;

  const { error } = await client.from("tutors_content_locks").delete().eq("course_id", courseId).eq("lo_route", loRoute);

  if (error) {
    log.error("removeLock failed:", error);
    return false;
  }
  return true;
}

/** The AccessStore over `client`; the composed (anon) client by default, which may only read locks. */
export function supabaseAccessStore(client?: SupabaseClient): AccessStore {
  if (!client) return { locks: getLocksForCourse, setLock: upsertLock, removeLock };
  return {
    locks: (courseId) => getLocksForCourse(courseId, client),
    setLock: (courseId, loRoute, locked, lockedBy) => upsertLock(courseId, loRoute, locked, lockedBy, client),
    removeLock: (courseId, loRoute) => removeLock(courseId, loRoute, client)
  };
}
