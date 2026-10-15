/**
 * The public catalogue (`tutors-connect-courses`) and the student count, as the reader's server
 * reads them for GET /api/catalogue, and the visit it records for POST /api/courses/visit with the
 * facts it read from the published course.
 */
import log from "@tutors/logger";
import { iso, num, run, type SqlClient } from "./client.ts";

/** One row of the catalogue: a course and how often it has been visited. */
interface CatalogueEntry {
  course_id: string;
  visited_at: Date;
  visit_count: number;
  course_record: Record<string, unknown> | null;
}

/** Reads of the catalogue; a failed read is logged and answered empty, so the catalogue page still renders. */
export interface CatalogueService {
  getCatalogue(): Promise<CatalogueEntry[]>;
  getCatalogueCount(): Promise<number>;
  getStudentCount(): Promise<number>;
}

async function orElse<T>(what: string, fallback: T, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    log.error("Reading the catalogue failed:", { what, error });
    return fallback;
  }
}

export function postgresCatalogue(sql: SqlClient): CatalogueService {
  const count = async (text: string) => num((await sql.query(text)).rows[0]?.n) ?? 0;
  return {
    getCatalogue: () =>
      orElse("courses", [], async () =>
        (await sql.query(`SELECT course_id, visited_at, visit_count, course_record FROM "tutors-connect-courses" ORDER BY visited_at DESC`)).rows.map(
          (r) => ({ ...r, visited_at: iso(r.visited_at), visit_count: num(r.visit_count) }) as unknown as CatalogueEntry
        )
      ),
    getCatalogueCount: () => orElse("course count", 0, () => count(`SELECT count(*) AS n FROM "tutors-connect-courses"`)),
    // A count, so no profile row is read (Rule 0070).
    getStudentCount: () => orElse("student count", 0, () => count(`SELECT count(*) AS n FROM "tutors-connect-profiles"`))
  };
}

/** Counts a visit to `courseId` and stores `record` as its card, in one statement. */
export async function recordCourseVisit(sql: SqlClient, courseId: string, record: Record<string, unknown>, now: Date = new Date()): Promise<void> {
  await run("tutors-connect-courses upsert", () =>
    sql.query(
      `INSERT INTO "tutors-connect-courses" (course_id, visited_at, visit_count, course_record) VALUES ($1, $2, 1, $3::jsonb)
       ON CONFLICT (course_id) DO UPDATE SET visited_at = EXCLUDED.visited_at, visit_count = COALESCE("tutors-connect-courses".visit_count, 0) + 1, course_record = EXCLUDED.course_record`,
      [courseId, now.toISOString(), JSON.stringify(record)]
    )
  );
}
