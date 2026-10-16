/**
 * The reader server's side of the Insights context: the use cases over the Postgres views the
 * composition root picked, the course's educators from its published enrollment, and the parsing of
 * what Tutors Time asks of GET /api/insights. Nothing here writes.
 */
import { educatorInsights } from "@tutors/application";
import { INSIGHTS_SPANS, type InsightsSpan } from "@tutors/application/ports";
import { readerServer } from "./api/adapters.ts";
import { educatorsOf } from "./snippets.ts";

/** The use cases over this server's views, or null when it keeps no insights (anonymous mode, or not on Postgres). */
export function insights(fetchFn: typeof fetch) {
  const { data } = readerServer();
  if (!data?.insights) return null;
  return educatorInsights({ insights: data.insights, educatorsOf: (courseId) => educatorsOf(courseId, (url) => fetchFn(url)) });
}

/** What Tutors Time asks: a course's insights, or one student's when `learnerId` is given. */
export type InsightsAsk = { courseId: string; span: InsightsSpan; day: string; learnerId: string | null };

const isSpan = (value: unknown): value is InsightsSpan => typeof value === "string" && (INSIGHTS_SPANS as readonly string[]).includes(value);

/** The ask in a query string, or why it is malformed. The day is checked by the use case. */
export function parseInsightsAsk(query: URLSearchParams): InsightsAsk | string {
  const courseId = query.get("courseId")?.trim() ?? "";
  if (!courseId || courseId.length > 200) return "courseId is required";
  const span = query.get("span") ?? "day";
  if (!isSpan(span)) return `span is one of ${INSIGHTS_SPANS.join(", ")}`;
  const day = query.get("day")?.trim() ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return "day is YYYY-MM-DD";
  const learnerId = query.get("learnerId")?.trim() || null;
  if (learnerId && learnerId.length > 200) return "learnerId is at most 200 characters";
  return { courseId, span, day, learnerId };
}

/** The status each refusal answers with, and its message. */
export const INSIGHTS_REFUSALS: Record<string, { status: number; message: string }> = {
  invalid: { status: 400, message: "That is not a course and a day tutors can read insights for" },
  forbidden: { status: 403, message: "Only an educator of the course may read its insights" },
  "not-ready": { status: 503, message: "Insights are not set up on this server yet" },
  unavailable: { status: 503, message: "The insights could not be read; try again" }
};
