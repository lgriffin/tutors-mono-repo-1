/**
 * The one read port insights compute from (Rule 0410): stored help requests, annotations and
 * reflections of a course over a bounded period. It has no write method.
 */
import type { HelpRequest } from "@tutors/domain/assistance";
import type { Annotation, Reflection } from "@tutors/domain/feedback";

/** A half-open period of ISO instants, `from` included and `to` not. */
export type InsightsPeriod = { from: string; to: string };

export interface InsightsRead {
  /** The course's help requests raised in the period, in no particular order. */
  helpRequests(courseId: string, period: InsightsPeriod): Promise<HelpRequest[]>;
  /** The course's annotations created in the period, revoked ones included. */
  annotations(courseId: string, period: InsightsPeriod): Promise<Annotation[]>;
  /** The course's reflections shared in the period. */
  reflections(courseId: string, period: InsightsPeriod): Promise<Reflection[]>;
}
