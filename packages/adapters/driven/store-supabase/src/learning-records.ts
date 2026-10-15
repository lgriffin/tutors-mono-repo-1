/** Reads of `calendar`, `learning_records` and `tutors-connect-users`: the application's LearningRecords port. */
import type { CalendarEntry, LearningRecord, TutorsConnectUser } from "@tutors/domain/learning";
import type { LearningRecords } from "@tutors/application/ports";
import log from "@tutors/logger";
import { type SupabaseClient } from "./client.ts";
import { readTimeRows } from "./time-rows.ts";

/** The LearningRecords port over `client` ; every read is empty without one. */
export function supabaseLearningRecords(client?: SupabaseClient): LearningRecords {
  const db = () => client;
  return {
    async calendarEntries(courseId, start, end) {
      const c = db();
      if (!c || !courseId) return [];
      let query = c.from("calendar").select("*").eq("courseid", courseId);
      if (start) query = query.gte("id", start);
      if (end) query = query.lte("id", end);
      const { data, error } = await query;
      if (error) {
        log.error("calendarEntries failed:", error);
        return [];
      }
      return (data ?? []) as CalendarEntry[];
    },
    async learningRecords(courseId, learnerId) {
      const c = db();
      if (!c || !courseId) return [];
      let query = c.from("learning_records").select("*").eq("course_id", courseId);
      if (learnerId) query = query.eq("student_id", learnerId);
      const { data, error } = await query;
      if (error) {
        log.error("learningRecords failed:", error);
        return [];
      }
      return (data ?? []) as LearningRecord[];
    },
    async learners(courseId) {
      const c = db();
      if (!c || !courseId) return [];
      const { data: records, error } = await c.from("learning_records").select("student_id").eq("course_id", courseId);
      if (error || !records?.length) return [];
      const ids = [...new Set(records.map((r: { student_id: string }) => r.student_id))];
      const { data, error: usersError } = await c.from("tutors-connect-users").select("*").in("github_id", ids);
      if (usersError) {
        log.error("learners failed:", usersError);
        return [];
      }
      return (data ?? []) as TutorsConnectUser[];
    },
    async timeRows(courseId, start, end) {
      const c = db();
      if (!c || !courseId) return { courseId, role: "educator", course: null, calendar: [], learningRecords: [], users: [], assignments: [] };
      return readTimeRows(c, courseId, start, end);
    }
  };
}
