/**
 * Reads of `calendar`, `learning_records`, `tutors-connect-users`, the catalogue row and the Moodle
 * assignments: the application's LearningRecords port, `timeRows` included (everything Tutors Time
 * shows about a course, read by the reader's server for GET /api/time/[courseId]). Rows come back in
 * the shapes the ports promise: dates as `YYYY-MM-DD`, timestamps as ISO strings,
 * counts as numbers.
 */
import type { CalendarEntry, LearningRecord, TutorsConnectUser, TutorsTimeAssignment, TutorsTimeRows } from "@tutors/domain/learning";
import type { LearningRecords } from "@tutors/application/ports";
import log from "@tutors/logger";
import { iso, num, run, type SqlClient } from "./client.ts";

type Row = Record<string, unknown>;

const CALENDAR = "SELECT id::text AS id, studentid, courseid, timeactive, pageloads FROM calendar";
const RECORDS = "SELECT course_id, student_id, lo_id, duration, count, date_last_accessed, type FROM learning_records";

const calendarRow = (r: Row) => ({ id: r.id, studentid: r.studentid, courseid: r.courseid, timeactive: num(r.timeactive), pageloads: num(r.pageloads) });
const recordRow = (r: Row) => ({
  course_id: r.course_id,
  student_id: r.student_id,
  lo_id: r.lo_id,
  duration: num(r.duration),
  count: num(r.count),
  date_last_accessed: iso(r.date_last_accessed),
  type: r.type
});
const userRow = (r: Row) => ({ ...r, date_last_accessed: iso(r.date_last_accessed) });

/** The calendar of `courseId` between two `YYYY-MM-DD` days, either end open. */
function readCalendar(sql: SqlClient, courseId: string, start?: string | null, end?: string | null) {
  return sql.query(`${CALENDAR} WHERE courseid = $1 AND ($2::date IS NULL OR id >= $2::date) AND ($3::date IS NULL OR id <= $3::date) ORDER BY id`, [courseId, start || null, end || null]);
}

/** A failed read is logged and answered empty. */
async function orEmpty<T>(what: string, read: () => Promise<T[]>): Promise<T[]> {
  try {
    return await read();
  } catch (error) {
    log.error("Reading learning records failed:", { what, error });
    return [];
  }
}

/** The course's Moodle assignments; a failed read is logged and answered empty, so the rest of the Time rows still show. */
async function readAssignments(sql: SqlClient, courseId: string): Promise<TutorsTimeAssignment[]> {
  const rows = await orEmpty("assignments", async () =>
    (await sql.query(
      `SELECT a.id, a.name, a.url, a.due_date, a.opened_date, count(s.id) AS submissions
       FROM assignments a LEFT JOIN assignments_submissions s ON s."assignmentId" = a.id
       WHERE a.courseid = $1 GROUP BY a.id ORDER BY a.id`,
      [courseId]
    )).rows
  );
  return rows.map((r) => ({
    id: num(r.id) as number,
    name: (r.name as string | null) ?? null,
    url: (r.url as string | null) ?? null,
    due_date: iso(r.due_date),
    opened_date: iso(r.opened_date),
    submissionCount: num(r.submissions) ?? 0
  }));
}

async function readTimeRows(sql: SqlClient, courseId: string, startDate?: string | null, endDate?: string | null): Promise<TutorsTimeRows> {
  const [course, calendar, records, assignments] = await Promise.all([
    run("tutors-connect-courses read", () => sql.query(`SELECT course_id, course_record FROM "tutors-connect-courses" WHERE course_id = $1`, [courseId])),
    run("calendar read", () => readCalendar(sql, courseId, startDate, endDate)),
    run("learning_records read", () => sql.query(`${RECORDS} WHERE course_id = $1 ORDER BY date_last_accessed DESC NULLS LAST`, [courseId])),
    readAssignments(sql, courseId)
  ]);
  const ids = new Set<string>();
  for (const r of calendar.rows) if (typeof r.studentid === "string" && r.studentid) ids.add(r.studentid);
  for (const r of records.rows) if (typeof r.student_id === "string" && r.student_id) ids.add(r.student_id);
  const users = ids.size
    ? (
        await run("tutors-connect-users read", () =>
          sql.query(`SELECT github_id, full_name, avatar_url, online_status, sentiment, date_last_accessed FROM "tutors-connect-users" WHERE github_id = ANY($1::text[])`, [[...ids]])
        )
      ).rows.map(userRow)
    : [];
  return {
    courseId,
    role: "educator",
    course: (course.rows[0] as TutorsTimeRows["course"]) ?? null,
    calendar: calendar.rows.map(calendarRow),
    learningRecords: records.rows.map(recordRow),
    users: users as TutorsTimeRows["users"],
    assignments
  };
}

export function postgresLearningRecords(sql: SqlClient): LearningRecords {
  return {
    calendarEntries: (courseId, start, end) =>
      courseId ? orEmpty("calendarEntries", async () => (await readCalendar(sql, courseId, start, end)).rows.map(calendarRow) as unknown as CalendarEntry[]) : Promise.resolve([]),
    learningRecords: (courseId, learnerId) =>
      courseId
        ? orEmpty("learningRecords", async () =>
            (await sql.query(`${RECORDS} WHERE course_id = $1 AND ($2::text IS NULL OR student_id = $2)`, [courseId, learnerId ?? null])).rows.map(recordRow) as LearningRecord[]
          )
        : Promise.resolve([]),
    learners: (courseId) =>
      courseId
        ? orEmpty("learners", async () =>
            (
              await sql.query(
                `SELECT u.* FROM "tutors-connect-users" u WHERE u.github_id IN (SELECT DISTINCT student_id FROM learning_records WHERE course_id = $1) ORDER BY u.github_id`,
                [courseId]
              )
            ).rows.map(userRow) as TutorsConnectUser[]
          )
        : Promise.resolve([]),
    timeRows: (courseId, start, end) =>
      courseId ? readTimeRows(sql, courseId, start, end) : Promise.resolve({ courseId, role: "educator", course: null, calendar: [], learningRecords: [], users: [], assignments: [] })
  };
}
