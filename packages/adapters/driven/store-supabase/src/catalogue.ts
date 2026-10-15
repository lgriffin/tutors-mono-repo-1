/**
 * The public catalogue (`tutors-connect-courses`) and the student count, as the reader's server reads
 * them for GET /api/catalogue with its service client. The browser reads neither: the catalogue app
 * asks the reader's data API.
 */
import log from "@tutors/logger";
import type { SupabaseClient } from "./client.ts";

/** One row of the catalogue: a course and how often it has been visited. */
export interface CatalogueEntry {
  course_id: string;
  visited_at: Date;
  visit_count: number;
  course_record: any;
}

/** Reads the catalogue of visited courses. */
export interface CatalogueService {
  getCatalogue(): Promise<CatalogueEntry[]>;
  getCatalogueCount(): Promise<number>;
  getStudentCount(): Promise<number>;
}

/** The catalogue over `db`; a failed read is logged and answered with an empty value, so the catalogue page still renders. */
export function supabaseCatalogue(db: SupabaseClient): CatalogueService {
  return {
    async getCatalogue() {
      try {
        const { data, error } = await db.from("tutors-connect-courses").select("*").order("visited_at", { ascending: false });
        if (error) throw error;
        return data as Array<CatalogueEntry>;
      } catch (error) {
        log.error("Error fetching courses:", error);
        return [];
      }
    },

    async getCatalogueCount() {
      try {
        const { count, error } = await db.from("tutors-connect-courses").select("*", { count: "exact", head: true });
        if (error) throw error;
        return count || 0;
      } catch (error) {
        log.error("Error fetching course count:", error);
        return 0;
      }
    },

    async getStudentCount() {
      try {
        // A count by a database function (supabase/migrations/20261017000200_create_get_student_count.sql): no profile row is read (Rule 0070).
        const { data, error } = await db.rpc("get_student_count");
        if (error) throw error;
        return Number(data) || 0;
      } catch (error) {
        log.error("Error fetching student count:", error);
        return 0;
      }
    }
  };
}
