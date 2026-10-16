/** Content locks in `tutors_content_locks`; `postgresAccessStore` is the application's AccessStore over them. */
import type { ContentLock } from "@tutors/domain/access";
import type { AccessStore } from "@tutors/application/ports";
import log from "@tutors/logger";
import { iso, type SqlClient } from "./client.ts";

/** The AccessStore the reader's server reads and changes behind /api/locks. It answers a failure with nothing rather than throwing. */
export function postgresAccessStore(sql: SqlClient): AccessStore {
  return {
    async locks(courseId) {
      if (!courseId) return [];
      try {
        const { rows } = await sql.query(`SELECT id::text AS id, course_id, lo_route, locked, locked_by, locked_at FROM tutors_content_locks WHERE course_id = $1 ORDER BY lo_route`, [courseId]);
        return rows.map((r) => ({ ...r, locked_at: iso(r.locked_at) })) as ContentLock[];
      } catch (error) {
        log.error("getLocksForCourse failed:", error);
        return [];
      }
    },
    async setLock(courseId, loRoute, locked, lockedBy) {
      if (!courseId || !loRoute || !lockedBy) return false;
      try {
        await sql.query(
          `INSERT INTO tutors_content_locks (course_id, lo_route, locked, locked_by, locked_at) VALUES ($1, $2, $3, $4, now())
           ON CONFLICT (course_id, lo_route) DO UPDATE SET locked = EXCLUDED.locked, locked_by = EXCLUDED.locked_by, locked_at = EXCLUDED.locked_at`,
          [courseId, loRoute, locked, lockedBy]
        );
        return true;
      } catch (error) {
        log.error("upsertLock failed:", error);
        return false;
      }
    },
    async removeLock(courseId, loRoute) {
      if (!courseId || !loRoute) return false;
      try {
        const { rows } = await sql.query(`DELETE FROM tutors_content_locks WHERE course_id = $1 AND lo_route = $2 RETURNING lo_route`, [courseId, loRoute]);
        return rows.length > 0;
      } catch (error) {
        log.error("removeLock failed:", error);
        return false;
      }
    }
  };
}
