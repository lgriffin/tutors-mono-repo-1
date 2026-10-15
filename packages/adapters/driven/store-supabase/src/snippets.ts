/**
 * Shared snippets in `course_gists`; `supabaseSnippetStore` is the application's SnippetStore over
 * them. The table is closed to the anon role (RLS on, no policies), so the client here is the
 * server's, bound to the service-role key, and only a route that has checked who is asking builds
 * one. Learner avatars are read from `tutors-connect-users`, the profile table this adapter owns.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { NewSnippet, SharedSnippet, SnippetStore } from "@tutors/application/ports";
import log from "@tutors/logger";

type Row = {
  id: string;
  created_at: string;
  expires_at: string;
  course_id: string;
  student_id: string;
  student_name: string | null;
  filename: string | null;
  content: string;
  title: string | null;
  lo_route: string | null;
  lo_title: string | null;
};

const fromRow = (row: Row): SharedSnippet => ({
  id: row.id,
  courseId: row.course_id,
  learnerId: row.student_id,
  learnerName: row.student_name,
  filename: row.filename ?? "snippet.txt",
  content: row.content,
  title: row.title,
  loRoute: row.lo_route,
  loTitle: row.lo_title,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  avatarUrl: null
});

export function supabaseSnippetStore(client: SupabaseClient): SnippetStore {
  async function avatars(ids: string[]): Promise<Map<string, string | null>> {
    const byLogin = new Map<string, string | null>();
    if (ids.length === 0) return byLogin;
    const { data, error } = await client.from("tutors-connect-users").select("github_id, avatar_url").in("github_id", ids);
    if (error) {
      log.warn("Reading snippet avatars failed:", error);
      return byLogin;
    }
    for (const user of (data ?? []) as { github_id?: string; avatar_url?: string | null }[]) {
      if (user.github_id) byLogin.set(user.github_id, user.avatar_url ?? null);
    }
    return byLogin;
  }

  return {
    async add(snippet: NewSnippet): Promise<string> {
      if (!snippet.courseId || !snippet.learnerId || !snippet.content) throw new Error("a snippet needs a course, a learner and a body");
      const { data, error } = await client
        .from("course_gists")
        .insert({
          course_id: snippet.courseId,
          student_id: snippet.learnerId,
          student_name: snippet.learnerName,
          filename: snippet.filename,
          content: snippet.content,
          title: snippet.title,
          lo_route: snippet.loRoute,
          lo_title: snippet.loTitle,
          expires_at: snippet.expiresAt
        })
        .select("id")
        .single();
      if (error || !data) {
        log.error("Inserting a course_gists row failed:", error);
        throw new Error(error?.message ?? "insert returned no row");
      }
      return (data as { id: string }).id;
    },

    async active(courseId: string, nowIso: string): Promise<SharedSnippet[]> {
      if (!courseId) return [];
      const { data, error } = await client
        .from("course_gists")
        .select("id, created_at, expires_at, course_id, student_id, student_name, filename, content, title, lo_route, lo_title")
        .eq("course_id", courseId)
        .gt("expires_at", nowIso)
        .order("created_at", { ascending: false });
      if (error) {
        log.error("Loading course snippets failed:", error);
        throw new Error(error.message);
      }
      const rows = ((data ?? []) as Row[]).map(fromRow);
      const byLogin = await avatars([...new Set(rows.map((row) => row.learnerId))]);
      for (const row of rows) row.avatarUrl = byLogin.get(row.learnerId) ?? null;
      return rows;
    },

    async countSince(courseId: string, learnerId: string, sinceIso: string): Promise<number | null> {
      const { count, error } = await client
        .from("course_gists")
        .select("id", { count: "exact", head: true })
        .eq("student_id", learnerId)
        .eq("course_id", courseId)
        .gte("created_at", sinceIso);
      if (error) {
        log.error("Counting a learner's snippets failed:", error);
        return null;
      }
      return count ?? 0;
    }
  };
}
