/**
 * What Tutors Time asks of the Insights context, as the educator signed in to it: a course's steps
 * ranked by the help they needed and its help response times over a chosen span (Rules 0412,
 * 0413), and one student's requests, hints, annotations and reflections (Rule 0414). The browser
 * computes nothing: an adapter sends each ask to whoever runs the Insights use cases (the reader's
 * server, GET /api/insights), which reads only educators of the course an answer.
 */
import type { CourseInsights, StudentProgress } from "@tutors/domain/insights";
import type { InsightsPeriod } from "./insights-read.ts";

/** The spans an educator picks from: the chosen day, the 7 days or the 30 days ending with it. */
export const INSIGHTS_SPANS = ["day", "week", "month"] as const;
export type InsightsSpan = (typeof INSIGHTS_SPANS)[number];

/**
 * Why there is no answer: `signed-out` (nobody is signed in, or the deployment has no sign-in),
 * `forbidden` (not an educator of the course, or a course that does not admit them), `not-kept`
 * (the deployment keeps no help requests or feedback), `not-ready` (the insights views are missing,
 * Rule 0416), `invalid` (a malformed ask) and `unavailable` (the read failed; try again).
 */
export type InsightsRefusal = "signed-out" | "forbidden" | "not-kept" | "not-ready" | "invalid" | "unavailable";

export type InsightsAnswer<T> = { ok: true; period: InsightsPeriod; value: T } | { ok: false; reason: InsightsRefusal };

export interface InsightsDesk {
  /** The course's ranked steps, response times and cohort over the span ending with `day` (`YYYY-MM-DD`). */
  course(courseId: string, span: InsightsSpan, day: string): Promise<InsightsAnswer<CourseInsights>>;
  /** One student's part in the course over the span ending with `day`. */
  student(courseId: string, learnerId: string, span: InsightsSpan, day: string): Promise<InsightsAnswer<StudentProgress>>;
}
