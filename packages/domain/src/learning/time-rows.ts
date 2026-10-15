/**
 * A course's time data as Tutors Time receives it in one answer: the calendar and learning-record
 * rows, the learners they name, the catalogue record and the assignments, and whether the viewer
 * sees it as an educator or as a student (pseudonymised).
 */
import type { TutorsConnectCourseRow, TutorsConnectUserRow } from "./rows.ts";

export interface TutorsTimeAssignment {
  id: number;
  name: string | null;
  url: string | null;
  due_date: string | null;
  opened_date: string | null;
  submissionCount: number;
}

export interface TutorsTimeRows {
  courseId: string;
  role: "educator" | "student";
  course: Pick<TutorsConnectCourseRow, "course_id" | "course_record"> | null;
  calendar: Record<string, unknown>[];
  learningRecords: Record<string, unknown>[];
  /** Never carries an email: the rows leave the server for another origin. */
  users: Omit<TutorsConnectUserRow, "email">[];
  assignments: TutorsTimeAssignment[];
}

/**
 * The rows as a student may see them: a fresh random pseudonym for each classmate, per answer. It
 * is the same for one student across the calendar and learning records of one answer, so medians
 * still work, but it neither follows row or alphabetical order nor survives to the next request: a
 * viewer cannot link a pseudonym across answers and single a classmate out over a term.
 */
export function pseudonymise(rows: TutorsTimeRows, viewer: string, randomId: () => string): TutorsTimeRows {
  const aliases = new Map<string, string>();
  const used = new Set<string>();
  const alias = (id: unknown): unknown => {
    if (typeof id !== "string" || id === viewer) return id;
    let a = aliases.get(id);
    if (!a) {
      do a = `student-${randomId().replace(/-/g, "").slice(0, 12)}`;
      while (used.has(a));
      aliases.set(id, a);
      used.add(a);
    }
    return a;
  };
  return {
    ...rows,
    role: "student",
    calendar: rows.calendar.map((r) => ({ ...r, studentid: alias(r.studentid) })),
    learningRecords: rows.learningRecords.map((r) => {
      const row: Record<string, unknown> = { ...r, student_id: alias(r.student_id) };
      delete row.full_name;
      return row;
    }),
    users: rows.users.filter((u) => u.github_id === viewer),
    assignments: []
  };
}
