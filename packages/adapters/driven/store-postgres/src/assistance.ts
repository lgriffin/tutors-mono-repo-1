/**
 * Help requests in `assistance_requests`; `postgresAssistanceStore` is the application's
 * AssistanceStore over them. Only the reader's server composes it, behind POST /api/assistance,
 * which has checked who is asking. A second live request of a learner in a course is refused by the
 * table's partial unique index, and `replace` is a compare-and-set on the stored state.
 */
import type { AssistanceStore } from "@tutors/application/ports";
import type { HelpClosure, HelpRequest, HelpState, NewHelpRequest } from "@tutors/domain/assistance";
import { iso, run, type SqlClient } from "./client.ts";

const COLUMNS = `id::text AS id, course_id, lab_route, step_id, learner_id, learner_name, kind, state, requested_at,
  acknowledged_by, acknowledged_at, closed_by, closed_at, closed_reason, hint_text`;

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
    hintText: (r.hint_text as string | null) ?? null
  };
}

export function postgresAssistanceStore(sql: SqlClient): AssistanceStore {
  return {
    async open(request: NewHelpRequest): Promise<HelpRequest> {
      if (!request.ref?.courseId || !request.learnerId) throw new Error("a help request needs a step and a learner");
      const { rows } = await run("assistance_requests insert", () =>
        sql.query(
          `INSERT INTO assistance_requests (course_id, lab_route, step_id, learner_id, learner_name, kind, state, requested_at,
             acknowledged_by, acknowledged_at, closed_by, closed_at, closed_reason, hint_text)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9, $10::timestamptz, $11, $12::timestamptz, $13, $14)
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
            request.hintText
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

    async replace(next: HelpRequest, from: HelpState): Promise<boolean> {
      if (!UUID.test(next.id)) return false;
      const { rows } = await run("assistance_requests update", () =>
        sql.query(
          `UPDATE assistance_requests SET lab_route = $3, step_id = $4, learner_name = $5, kind = $6, state = $7,
             acknowledged_by = $8, acknowledged_at = $9::timestamptz, closed_by = $10, closed_at = $11::timestamptz, closed_reason = $12, hint_text = $13
           WHERE id = $1::uuid AND state = $2
           RETURNING id::text AS id`,
          [
            next.id,
            from,
            next.ref.labRoute,
            next.ref.stepId,
            next.learnerName,
            next.kind,
            next.state,
            next.acknowledged?.by ?? null,
            next.acknowledged?.at ?? null,
            next.closed?.by ?? null,
            next.closed?.at ?? null,
            next.closed?.reason ?? null,
            next.hintText
          ]
        )
      );
      return rows.length === 1;
    }
  };
}
