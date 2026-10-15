/**
 * CourseTime, the time app's per-course read model, over the rows a TutorsTimeSource answers with:
 * how it turns 30-second blocks into minutes and attaches learners' names, what it asks the source
 * for, and how a failed read is reported. The default source (supabaseTimeSource) is driven over a
 * scripted Supabase client at the end, with what it asks the database for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedSupabase } from "../../support/scripted-supabase.ts";
import type { TutorsTimeRows } from "../../../packages/domain/src/learning/time-rows.ts";

const supabase = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../../../packages/jsr/time/src/services/supabase.ts", () => ({ getSupabase: () => supabase.current, initSupabase: vi.fn() }));

import { CourseTime } from "../../../packages/jsr/time/src/services/course-time.ts";
import { setTutorsTimeSource, supabaseTimeSource, type TutorsTimeSource } from "../../../packages/jsr/time/src/services/source.ts";

const entry = (studentid: string, id: string, timeactive: number) => ({ id, courseid: "cs101", studentid, timeactive, pageloads: 1 });
const record = (student_id: string, lo_id: string, duration: number | null) => ({ course_id: "cs101", student_id, lo_id, type: "lab", duration, date_last_accessed: "2026-01-05" });
const user = (github_id: string, full_name: string) => ({ github_id, full_name, avatar_url: null, online_status: null, sentiment: null, date_last_accessed: null });

type Asked = { courseId: string; startDate?: string | null; endDate?: string | null };

/** A source answering the scripted rows in order (an Error entry rejects), recording what was asked. */
function scriptedSource(answers: (Partial<TutorsTimeRows> | Error)[]) {
  const asked: Asked[] = [];
  const source: TutorsTimeSource = {
    async courseRows(courseId, startDate, endDate) {
      asked.push({ courseId, startDate, endDate });
      const next = answers.shift() ?? {};
      if (next instanceof Error) throw next;
      return { courseId, role: "educator", course: null, calendar: [], learningRecords: [], users: [], assignments: [], ...next };
    },
    async courseRecord(courseId) {
      return (await this.courseRows(courseId)).course;
    },
    async user(studentId, courseId) {
      return courseId ? ((await this.courseRows(courseId)).users.find((u) => u.github_id === studentId) ?? null) : null;
    }
  };
  setTutorsTimeSource(source);
  return { asked };
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ properties: { ignorepin: "4321" } }) }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  setTutorsTimeSource(supabaseTimeSource());
});

describe("calendar data", () => {
  it("orders a course's calendar by id, converts blocks to minutes and attaches full names", async () => {
    const { asked } = scriptedSource([
      { calendar: [entry("bob", "2026-01-06", null as never), entry("ann", "2026-01-05", 4)], users: [user("ann", "Ann A"), user("bob", "  ")] }
    ]);
    const entries = await CourseTime.getCalendarData("cs101");
    expect(entries.map((e) => [e.studentid, e.full_name, e.timeactive])).toEqual([
      ["ann", "Ann A", 2],
      ["bob", "bob", 0]
    ]);
    expect(asked).toEqual([{ courseId: "cs101", startDate: undefined, endDate: undefined }]);
  });

  it("uses the student id as the name when the source names nobody", async () => {
    scriptedSource([{ calendar: [entry("ann", "2026-01-05", 2)] }, { calendar: [] }]);
    expect((await CourseTime.getCalendarData("cs101")).map((e) => e.full_name)).toEqual(["ann"]);
    expect(await CourseTime.getCalendarData("cs101")).toEqual([]);
  });

  it("reports a failed calendar read", async () => {
    scriptedSource([new Error("Failed to fetch calendar data: down")]);
    await expect(CourseTime.getCalendarData("cs101")).rejects.toThrow("Failed to fetch calendar data: down");
  });
});

describe("learning records", () => {
  it("reads one learner's records of a type, and none on a failed read", async () => {
    scriptedSource([{ learningRecords: [record("ann", "/lab/1", 2), record("bob", "/lab/1", 3), { ...record("ann", "/note/1", 1), type: "note" }] }, new Error("down")]);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await CourseTime.getLearningRecords("ann", "cs101", "lab")).toEqual([record("ann", "/lab/1", 2)]);
    expect(await CourseTime.getLearningRecords("ann", "cs101", "lab")).toEqual([]);
    expect(stderr).toHaveBeenCalledWith("Failed to fetch learning records: down\n");
    stderr.mockRestore();
  });

  it("reads a course's records, converts durations to minutes and orders by learner then learning object", async () => {
    scriptedSource([{ learningRecords: [record("bob", "/lab/2", 4), record("ann", "/lab/2", null), record("bob", "/lab/1", 2), record("ann", "/lab/1", 6)] }]);
    const records = await CourseTime.getAllLearningRecordsForCourse("cs101");
    expect(records.map((r) => [r.student_id, r.lo_id, r.duration])).toEqual([
      ["ann", "/lab/1", 3],
      ["ann", "/lab/2", null],
      ["bob", "/lab/1", 1],
      ["bob", "/lab/2", 2]
    ]);
  });

  it("reports a failed records read", async () => {
    scriptedSource([new Error("Failed to fetch learning records: down")]);
    await expect(CourseTime.getAllLearningRecordsForCourse("cs101")).rejects.toThrow("Failed to fetch learning records: down");
  });
});

describe("loadTime", () => {
  it("loads a course's calendar within the dates, its learning records, its models and its pin, in one read", async () => {
    // The date range goes to the source (Rule 0319), so only the days in range leave the server.
    const { asked } = scriptedSource([{ calendar: [entry("ann", "2026-01-05", 2)], users: [user("ann", "Ann A")], learningRecords: [record("ann", "/lab/1", 2)] }]);
    const course = await new CourseTime().loadTime(" cs101 ", "2026-01-01", "2026-01-31", "CS101");
    expect(course.id).toBe("cs101");
    expect(course.title).toBe("CS101");
    expect(course.data.map((e) => [e.id, e.full_name])).toEqual([["2026-01-05", "Ann A"]]);
    expect(asked).toEqual([{ courseId: "cs101", startDate: "2026-01-01", endDate: "2026-01-31" }]);
    expect(course.learningRecords).toHaveLength(1);
    expect(course.learningRecordsError).toBeNull();
    expect(course.error).toBeNull();
    expect(course.pin).toBe("4321");
    expect(course.calendarModel).toBeDefined();
    expect(course.labsModel).toBeDefined();
  });

  it("needs a course id, and reports a failed read as a failed load", async () => {
    await expect(new CourseTime().loadTime("  ", null, null, "CS101")).rejects.toThrow("Course ID is required");
    scriptedSource([new Error("down")]);
    await expect(new CourseTime().loadTime("cs101", null, null, "CS101")).rejects.toThrow("Failed to load calendar data");
  });
});

describe("the Supabase source (the default, when no reader is set)", () => {
  it("reads the calendar within the dates in id order, the learning records and the learners' names, in pages", async () => {
    const { client, calls } = scriptedSupabase({
      calendar: [{ data: [entry("ann", "2026-01-05", 4)] }],
      learning_records: [{ data: [record("ann", "/lab/1", 2)] }],
      "tutors-connect-courses": [{ data: { course_id: "cs101", course_record: { title: "CS101" } } }],
      "tutors-connect-users": [{ data: [user("ann", "Ann A")] }]
    });
    supabase.current = client;
    const rows = await supabaseTimeSource().courseRows("cs101", "2026-01-01", "2026-01-31");
    expect(rows.role).toBe("educator");
    expect(rows.calendar).toEqual([entry("ann", "2026-01-05", 4)]);
    expect(rows.learningRecords).toEqual([record("ann", "/lab/1", 2)]);
    expect(rows.users.map((u) => u.github_id)).toEqual(["ann"]);
    expect(rows.course).toEqual({ course_id: "cs101", course_record: { title: "CS101" } });
    expect(calls.filter((c) => c.table === "calendar").map((c) => c.op)).toEqual(["select", "eq", "order", "gte", "lte", "range"]);
    expect(calls.find((c) => c.op === "in")?.args).toEqual(["github_id", ["ann"]]);
  });

  it("reports a failed calendar read, and answers nobody for an unknown learner", async () => {
    supabase.current = scriptedSupabase({ calendar: [{ data: null, error: { message: "down" } }] }).client;
    await expect(supabaseTimeSource().courseRows("cs101")).rejects.toThrow("Failed to fetch calendar data: down");
    expect(await supabaseTimeSource().user("nobody")).toBeNull();
  });
});
