/**
 * The insights use cases: read the stored rows of a bounded period through InsightsRead and
 * aggregate them in the domain (Rule 0410). Nothing here writes.
 */
import { responseTimes, stepDiagnostics as diagnose, studentProgress as progressOf, type ResponseTimes, type StepDiagnostic, type StudentProgress } from "@tutors/domain/insights";
import type { InsightsPeriod, InsightsRead } from "../ports/insights-read.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The UTC day `YYYY-MM-DD` as a period. */
export function dayPeriod(day: string): InsightsPeriod {
  const from = Date.parse(`${day}T00:00:00.000Z`);
  return { from: new Date(from).toISOString(), to: new Date(from + DAY_MS).toISOString() };
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
