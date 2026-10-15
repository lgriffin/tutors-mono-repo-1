/**
 * Help requests in `assistance_requests`; `postgresAssistanceStore` is the application's
 * AssistanceStore over them. Only the reader's server composes it, behind POST /api/assistance,
 * which has checked who is asking. A second live request of a learner in a course is refused by the
 * table's partial unique index, and `replace` is a compare-and-set on the state, kind, step and
 * rating it was read with. The use cases answer a failed query as "try again", so each one is logged here.
 */
import log from "@tutors/logger";
import type { AssistanceStore } from "@tutors/application/ports";
import type { HelpClosure, HelpRequest, HelpState, NewHelpRequest } from "@tutors/domain/assistance";
import { iso, run as runQuery, type SqlClient } from "./client.ts";

/** Runs a query, logging why it failed before the use case turns the failure into a refusal. */
async function run<T>(what: string, query: () => Promise<T>): Promise<T> {
  try {
    return await runQuery(what, query);
  } catch (error) {
    log.error("A help request query failed:", what, error);
    throw error;
  }
}

const COLUMNS = `id::text AS id, course_id, lab_route, step_id, learner_id, learner_name, kind, state, requested_at,
  acknowledged_by, acknowledged_at, closed_by, closed_at, closed_reason, hint_text, helped`;

/** A UUID; any other id names no row, so it is answered without asking the database. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fromRow(r: Record<string, unknown>): HelpRequest {
  const acknowledgedAt = iso(r.acknowledged_at);
  const closedAt = iso(r.closed_at);
  return {
    id: r.id as string,
    ref: { courseId: r.course_id as string, labRoute: r.lab_route as string, stepId: r.step_id as string },
    learnerId: r.learner_id as string,
    learnerName: (r.learner_name as string | null) ?? null,
    kind: r.kind as HelpRequest["kind"],
    state: r.state as HelpState,
    requestedAt: iso(r.requested_at) as string,
    acknowledged: r.acknowledged_by && acknowledgedAt ? { by: r.acknowledged_by as string, at: acknowledgedAt } : null,
    closed: r.closed_by && closedAt && r.closed_reason ? { by: r.closed_by as string, at: closedAt, reason: r.closed_reason as HelpClosure["reason"] } : null,
    hintText: (r.hint_text as string | null) ?? null,
    helped: typeof r.helped === "boolean" ? r.helped : null
  };
}

export function postgresAssistanceStore(sql: SqlClient): AssistanceStore {
  return {
    async open(request: NewHelpRequest): Promise<HelpRequest> {
      if (!request.ref?.courseId || !request.learnerId) throw new Error("a help request needs a step and a learner");
      const { rows } = await run("assistance_requests insert", () =>
        sql.query(
          `INSERT INTO assistance_requests (course_id, lab_route, step_id, learner_id, learner_name, kind, state, requested_at,
             acknowledged_by, acknowledged_at, closed_by, closed_at, closed_reason, hint_text, helped)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9, $10::timestamptz, $11, $12::timestamptz, $13, $14, $15)
           RETURNING ${COLUMNS}`,
          [
            request.ref.courseId,
            request.ref.labRoute,
            request.ref.stepId,
            request.learnerId,
            request.learnerName,
            request.kind,
            request.state,
            request.requestedAt,
            request.acknowledged?.by ?? null,
            request.acknowledged?.at ?? null,
            request.closed?.by ?? null,
            request.closed?.at ?? null,
            request.closed?.reason ?? null,
            request.hintText,
            request.helped ?? null
          ]
        )
      );
      return fromRow(rows[0]);
    },

    async get(id: string): Promise<HelpRequest | null> {
      if (!UUID.test(id)) return null;
      const { rows } = await run("assistance_requests select", () => sql.query(`SELECT ${COLUMNS} FROM assistance_requests WHERE id = $1::uuid`, [id]));
      return rows[0] ? fromRow(rows[0]) : null;
    },

    async live(courseId: string): Promise<HelpRequest[]> {
      if (!courseId) return [];
      const { rows } = await run("assistance_requests live", () =>
        sql.query(`SELECT ${COLUMNS} FROM assistance_requests WHERE course_id = $1 AND state IN ('open', 'acknowledged')`, [courseId])
      );
      return rows.map(fromRow);
    },

    async latest(courseId: string, learnerId: string): Promise<HelpRequest | null> {
      if (!courseId || !learnerId) return null;
      const { rows } = await run("assistance_requests latest", () =>
        sql.query(`SELECT ${COLUMNS} FROM assistance_requests WHERE course_id = $1 AND learner_id = $2 ORDER BY requested_at DESC LIMIT 1`, [courseId, learnerId])
      );
      return rows[0] ? fromRow(rows[0]) : null;
    },

    async replace(next: HelpRequest, prior: HelpRequest): Promise<boolean> {
      if (!UUID.test(next.id)) return false;
      const { rows } = await run("assistance_requests update", () =>
        sql.query(
          `UPDATE assistance_requests SET course_id = $6, lab_route = $7, step_id = $8, learner_id = $9, learner_name = $10, kind = $11, state = $12,
             requested_at = $13::timestamptz, acknowledged_by = $14, acknowledged_at = $15::timestamptz, closed_by = $16, closed_at = $17::timestamptz,
             closed_reason = $18, hint_text = $19, helped = $21
           WHERE id = $1::uuid AND state = $2 AND kind = $3 AND lab_route = $4 AND step_id = $5 AND helped IS NOT DISTINCT FROM $20::boolean
           RETURNING id::text AS id`,
          [
            next.id,
            prior.state,
            prior.kind,
            prior.ref.labRoute,
            prior.ref.stepId,
            next.ref.courseId,
            next.ref.labRoute,
            next.ref.stepId,
            next.learnerId,
            next.learnerName,
            next.kind,
            next.state,
            next.requestedAt,
            next.acknowledged?.by ?? null,
            next.acknowledged?.at ?? null,
            next.closed?.by ?? null,
            next.closed?.at ?? null,
            next.closed?.reason ?? null,
            next.hintText,
            prior.helped ?? null,
            next.helped ?? null
          ]
        )
      );
      return rows.length === 1;
    }
  };
}
