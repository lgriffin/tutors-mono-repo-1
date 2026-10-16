/**
 * The insights use cases: read the stored rows of a bounded period through InsightsRead and
 * aggregate them in the domain (Rule 0410). Nothing here writes.
 */
import {
  courseInsights as insightsOf,
  responseTimes,
  stepDiagnostics as diagnose,
  studentProgress as progressOf,
  type CourseInsights,
  type ResponseTimes,
  type StepDiagnostic,
  type StudentProgress
} from "@tutors/domain/insights";
import { isEducatorOf } from "@tutors/domain/access";
import type { InsightsAnswer, InsightsSpan } from "../ports/insights-desk.ts";
import { InsightsNotReadyError, type InsightsPeriod, type InsightsRead } from "../ports/insights-read.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The UTC day `YYYY-MM-DD` as a period. */
export function dayPeriod(day: string): InsightsPeriod {
  const from = Date.parse(`${day}T00:00:00.000Z`);
  return { from: new Date(from).toISOString(), to: new Date(from + DAY_MS).toISOString() };
}

const SPAN_DAYS: Record<InsightsSpan, number> = { day: 1, week: 7, month: 30 };

/**
 * The span ending with the UTC day `YYYY-MM-DD`, that day included: the day alone, the 7 days or
 * the 30 days up to it. Null for anything but a real calendar day, so a read is always bounded
 * (Rule 0417).
 */
export function insightsPeriod(span: InsightsSpan, day: string): InsightsPeriod | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Object.hasOwn(SPAN_DAYS, span)) return null;
  const end = Date.parse(`${day}T00:00:00.000Z`) + DAY_MS;
  if (Number.isNaN(end) || new Date(end - DAY_MS).toISOString().slice(0, 10) !== day) return null;
  return { from: new Date(end - SPAN_DAYS[span] * DAY_MS).toISOString(), to: new Date(end).toISOString() };
}

/** A course's steps ranked by the help they needed, its response times per day and kind, and its cohort (Rules 0412, 0413, 0415). */
export function courseInsights({ insights }: { insights: InsightsRead }) {
  return async (courseId: string, period: InsightsPeriod): Promise<CourseInsights> => {
    const [requests, annotations, reflections] = await Promise.all([
      insights.helpRequests(courseId, period),
      insights.annotations(courseId, period),
      insights.reflections(courseId, period)
    ]);
    return insightsOf(courseId, requests, annotations, reflections);
  };
}

/** A diagnostic per step of the course that had requests or annotations on the day (Rule 0411). */
export function stepDiagnostics({ insights }: { insights: InsightsRead }) {
  return async (courseId: string, day: string): Promise<StepDiagnostic[]> => {
    const period = dayPeriod(day);
    const [requests, annotations] = await Promise.all([insights.helpRequests(courseId, period), insights.annotations(courseId, period)]);
    return diagnose(day, requests, annotations);
  };
}

/** One student's requests, hints, annotations and reflections in a course over the period. */
export function studentProgress({ insights }: { insights: InsightsRead }) {
  return async (courseId: string, learnerId: string, period: InsightsPeriod): Promise<StudentProgress> => {
    const [requests, annotations, reflections] = await Promise.all([
      insights.helpRequests(courseId, period),
      insights.annotations(courseId, period),
      insights.reflections(courseId, period)
    ]);
    return progressOf(learnerId, requests, annotations, reflections);
  };
}

/** Time to acknowledge and to resolve per kind of help over the period. */
export function helpResponseTimes({ insights }: { insights: InsightsRead }) {
  return async (courseId: string, period: InsightsPeriod): Promise<ResponseTimes> => responseTimes(await insights.helpRequests(courseId, period));
}

export type InsightsDeps = { insights: InsightsRead; educatorsOf: (courseId: string) => Promise<string[]> };

/**
 * What an educator of the course reads of its insights, as `login`: anyone else is refused before a
 * row is read, an ask that names no real day is invalid, and a failed read is `not-ready` when the
 * insights views are missing (Rule 0416) and `unavailable` otherwise.
 */
export function educatorInsights(deps: InsightsDeps) {
  const ofCourse = courseInsights(deps);
  const ofStudent = studentProgress(deps);
  async function answer<T>(login: string, courseId: string, span: InsightsSpan, day: string, read: (period: InsightsPeriod) => Promise<T>): Promise<InsightsAnswer<T>> {
    const period = insightsPeriod(span, day);
    if (!courseId || !period) return { ok: false, reason: "invalid" };
    let educators: string[];
    try {
      educators = await deps.educatorsOf(courseId);
    } catch {
      return { ok: false, reason: "unavailable" };
    }
    if (!isEducatorOf(login, { educators })) return { ok: false, reason: "forbidden" };
    try {
      return { ok: true, period, value: await read(period) };
    } catch (error) {
      return { ok: false, reason: error instanceof InsightsNotReadyError ? "not-ready" : "unavailable" };
    }
  }
  return {
    course: (login: string, courseId: string, span: InsightsSpan, day: string) => answer(login, courseId, span, day, (period) => ofCourse(courseId, period)),
    student: (login: string, courseId: string, learnerId: string, span: InsightsSpan, day: string) =>
      learnerId ? answer(login, courseId, span, day, (period) => ofStudent(courseId, learnerId, period)) : Promise.resolve({ ok: false, reason: "invalid" } as const)
  };
}
