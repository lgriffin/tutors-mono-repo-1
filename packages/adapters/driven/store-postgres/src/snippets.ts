/**
 * Shared snippets in `course_gists`; `postgresSnippetStore` is the application's SnippetStore over
 * them. Only a server route that has checked who is asking composes it. Learner avatars are read
 * from `tutors-connect-users`.
 */
import type { NewSnippet, SharedSnippet, SnippetStore } from "@tutors/application/ports";
import log from "@tutors/logger";
import { iso, num, run, type SqlClient } from "./client.ts";

export function postgresSnippetStore(sql: SqlClient): SnippetStore {
  return {
    async add(snippet: NewSnippet): Promise<string> {
      if (!snippet.courseId || !snippet.learnerId || !snippet.content) throw new Error("a snippet needs a course, a learner and a body");
      const { rows } = await run("course_gists insert", () =>
        sql.query<{ id: string }>(
          `INSERT INTO course_gists (course_id, student_id, student_name, filename, content, title, lo_route, lo_title, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id::text AS id`,
          [snippet.courseId, snippet.learnerId, snippet.learnerName, snippet.filename, snippet.content, snippet.title, snippet.loRoute, snippet.loTitle, snippet.expiresAt]
        )
      );
      return rows[0].id;
    },

    async active(courseId: string, nowIso: string): Promise<SharedSnippet[]> {
      if (!courseId) return [];
      const { rows } = await run("course_gists select", () =>
        sql.query(
          `SELECT g.id::text AS id, g.created_at, g.expires_at, g.course_id, g.student_id, g.student_name, g.filename, g.content, g.title, g.lo_route, g.lo_title, u.avatar_url
           FROM course_gists g LEFT JOIN "tutors-connect-users" u ON u.github_id = g.student_id
           WHERE g.course_id = $1 AND g.expires_at > $2::timestamptz
           ORDER BY g.created_at DESC`,
          [courseId, nowIso]
        )
      );
      return rows.map((r) => ({
        id: r.id as string,
        courseId: r.course_id as string,
        learnerId: r.student_id as string,
        learnerName: (r.student_name as string | null) ?? null,
        filename: (r.filename as string | null) ?? "snippet.txt",
        content: r.content as string,
        title: (r.title as string | null) ?? null,
        loRoute: (r.lo_route as string | null) ?? null,
        loTitle: (r.lo_title as string | null) ?? null,
        createdAt: iso(r.created_at) as string,
        expiresAt: iso(r.expires_at) as string,
        avatarUrl: (r.avatar_url as string | null) ?? null
      }));
    },

    async countSince(courseId: string, learnerId: string, sinceIso: string): Promise<number | null> {
      try {
        const { rows } = await sql.query(`SELECT count(*) AS n FROM course_gists WHERE student_id = $1 AND course_id = $2 AND created_at >= $3::timestamptz`, [
          learnerId,
          courseId,
          sinceIso
        ]);
        return num(rows[0]?.n) ?? 0;
      } catch (error) {
        log.error("Counting a learner's snippets failed:", error);
        return null;
      }
    }
  };
}

/**
 * Deletes the snippets that expired at or before `nowIso` (`scripts/purge-course-gists.ts`, run by
 * `.github/workflows/gist-cleanup.yml`): reads already hide them, so this reclaims the storage. One
 * statement per batch of `batchSize`, at most `maxBatches`; answers how many rows were deleted, or,
 * with `dryRun`, how many would be.
 */
export async function purgeExpiredSnippets(sql: SqlClient, nowIso: string, options: { batchSize?: number; maxBatches?: number; dryRun?: boolean } = {}): Promise<number> {
  if (options.dryRun) {
    const { rows } = await run("course_gists count expired", () =>
      sql.query<{ n: number }>(`SELECT count(*)::int AS n FROM course_gists WHERE expires_at <= $1::timestamptz`, [nowIso])
    );
    return rows[0].n;
  }
  const batchSize = Math.max(1, options.batchSize ?? 200);
  let deleted = 0;
  for (let batch = 0; batch < Math.max(1, options.maxBatches ?? 50); batch++) {
    const { rows } = await run("course_gists purge", () =>
      sql.query<{ id: string }>(
        `DELETE FROM course_gists WHERE id IN (SELECT id FROM course_gists WHERE expires_at <= $1::timestamptz ORDER BY expires_at LIMIT $2) RETURNING id::text AS id`,
        [nowIso, batchSize]
      )
    );
    deleted += rows.length;
    if (rows.length < batchSize) break;
  }
  return deleted;
}
