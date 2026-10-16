/**
 * The Insights context's InsightsRead over `insights_help_requests`, `insights_annotations` and
 * `insights_reflections`: views of the assistance and feedback rows without their free text, so a
 * request carries no hint or student name and an annotation or reflection no body. Every read names
 * a course and a half-open period, served by an index that leads with both (Rule 0417); nothing here
 * writes (Rule 0410) or computes a number, which the domain does. A database whose migrations have
 * not made the views yet answers InsightsNotReadyError (Rule 0416). Only the reader's server
 * composes it, behind GET /api/insights, which has checked that an educator of the course asks.
 */
import log from "@tutors/logger";
import { InsightsNotReadyError, type InsightsPeriod, type InsightsRead } from "@tutors/application/ports";
import type { HelpClosure, HelpRequest, HelpState } from "@tutors/domain/assistance";
import type { Annotation, Anchor, Reflection } from "@tutors/domain/feedback";
import { isNoteKind, type StepRef } from "@tutors/domain/learning";
import { iso, run as runQuery, type SqlClient } from "./client.ts";

/** Postgres's undefined_table: the view this read names does not exist yet. */
const UNDEFINED_TABLE = "42P01";

const codeOf = (error: unknown): unknown => (error && typeof error === "object" && "code" in error ? (error as { code: unknown }).code : undefined);

async function read(sql: SqlClient, what: string, text: string, courseId: string, period: InsightsPeriod): Promise<Record<string, unknown>[]> {
  let missing = false;
  try {
    const { rows } = await runQuery(what, () =>
      sql.query(text, [courseId, period.from, period.to]).catch((error: unknown) => {
        missing = codeOf(error) === UNDEFINED_TABLE;
        throw error;
      })
    );
    return rows;
  } catch (error) {
    if (missing) {
      log.warn("The insights views are missing; run the migrations:", what);
      throw new InsightsNotReadyError();
    }
    log.error("An insights query failed:", what, error);
    throw error;
  }
}

const refOf = (r: Record<string, unknown>): StepRef => ({ courseId: r.course_id as string, labRoute: r.lab_route as string, stepId: r.step_id as string });

function requestFromRow(r: Record<string, unknown>): HelpRequest {
  const acknowledgedAt = iso(r.acknowledged_at);
  const closedAt = iso(r.closed_at);
  return {
    id: r.id as string,
    ref: refOf(r),
    learnerId: r.learner_id as string,
    learnerName: null,
    kind: r.kind as HelpRequest["kind"],
    state: r.state as HelpState,
    requestedAt: iso(r.requested_at) as string,
    acknowledged: r.acknowledged_by && acknowledgedAt ? { by: r.acknowledged_by as string, at: acknowledgedAt } : null,
    closed: r.closed_by && closedAt && r.closed_reason ? { by: r.closed_by as string, at: closedAt, reason: r.closed_reason as HelpClosure["reason"] } : null,
    hintText: null,
    helped: typeof r.helped === "boolean" ? r.helped : null
  };
}

function anchorOf(r: Record<string, unknown>, ref: StepRef): Anchor {
  if (r.anchor_kind === "snippet") return { kind: "snippet", ref, snippetId: r.anchor_id as string };
  if (r.anchor_kind === "reflection") return { kind: "reflection", ref, reflectionId: r.anchor_id as string };
  return { kind: "step", ref };
}

function annotationFromRow(r: Record<string, unknown>): Annotation {
  return {
    id: r.id as string,
    anchor: anchorOf(r, refOf(r)),
    audience: r.audience === "everyone" ? { kind: "everyone" } : { kind: "student", learnerId: r.learner_id as string },
    body: "",
    authorId: r.author_id as string,
    createdAt: iso(r.created_at) as string,
    revokedAt: iso(r.revoked_at) ?? null
  };
}

function reflectionFromRow(r: Record<string, unknown>): Reflection {
  return { id: r.id as string, ref: refOf(r), learnerId: r.learner_id as string, body: "", kind: isNoteKind(r.kind) ? r.kind : "note", sharedAt: iso(r.shared_at) as string };
}

export function postgresInsightsRead(sql: SqlClient): InsightsRead {
  return {
    async helpRequests(courseId, period) {
      const rows = await read(
        sql,
        "insights_help_requests",
        `SELECT id::text AS id, course_id, lab_route, step_id, learner_id, kind, state, requested_at, acknowledged_by, acknowledged_at, closed_by, closed_at, closed_reason, helped
         FROM insights_help_requests WHERE course_id = $1 AND requested_at >= $2::timestamptz AND requested_at < $3::timestamptz ORDER BY requested_at, id`,
        courseId,
        period
      );
      return rows.map(requestFromRow);
    },
    async annotations(courseId, period) {
      const rows = await read(
        sql,
        "insights_annotations",
        `SELECT id::text AS id, course_id, lab_route, step_id, anchor_kind, anchor_id, audience, learner_id, author_id, created_at, revoked_at
         FROM insights_annotations WHERE course_id = $1 AND created_at >= $2::timestamptz AND created_at < $3::timestamptz ORDER BY created_at, id`,
        courseId,
        period
      );
      return rows.map(annotationFromRow);
    },
    async reflections(courseId, period) {
      const rows = await read(
        sql,
        "insights_reflections",
        `SELECT id::text AS id, course_id, lab_route, step_id, learner_id, kind, shared_at
         FROM insights_reflections WHERE course_id = $1 AND shared_at >= $2::timestamptz AND shared_at < $3::timestamptz ORDER BY shared_at, id`,
        courseId,
        period
      );
      return rows.map(reflectionFromRow);
    }
  };
}
