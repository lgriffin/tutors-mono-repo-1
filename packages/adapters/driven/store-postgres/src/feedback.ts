/**
 * Lecturers' annotations in `feedback_annotations` and students' shared reflections in
 * `feedback_reflections`; `postgresFeedbackStore` is the application's FeedbackStore over them.
 * Only the reader's server composes it, behind /api/feedback, which has checked who is asking. An
 * annotation's anchor is its step plus, for a snippet or a reflection, that thing's id; its audience
 * is one learner or everyone. A revoke keeps the row and its first revocation time (Rule 0406).
 * The use cases answer a failed query as "try again", so each one is logged here.
 */
import log from "@tutors/logger";
import type { FeedbackStore } from "@tutors/application/ports";
import type { Anchor, Annotation, NewAnnotation, NewReflection, Reflection } from "@tutors/domain/feedback";
import { isNoteKind, type StepRef } from "@tutors/domain/learning";
import { iso, run as runQuery, type SqlClient } from "./client.ts";

async function run<T>(what: string, query: () => Promise<T>): Promise<T> {
  try {
    return await runQuery(what, query);
  } catch (error) {
    log.error("A feedback query failed:", what, error);
    throw error;
  }
}

const ANNOTATION = `id::text AS id, course_id, lab_route, step_id, anchor_kind, anchor_id, audience, learner_id, body, author_id, created_at, revoked_at`;
const REFLECTION = `id::text AS id, course_id, lab_route, step_id, learner_id, kind, body, shared_at`;

/** A UUID; any other id names no row, so it is answered without asking the database. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function anchorOf(r: Record<string, unknown>, ref: StepRef): Anchor {
  if (r.anchor_kind === "snippet") return { kind: "snippet", ref, snippetId: r.anchor_id as string };
  if (r.anchor_kind === "reflection") return { kind: "reflection", ref, reflectionId: r.anchor_id as string };
  return { kind: "step", ref };
}

function annotationFromRow(r: Record<string, unknown>): Annotation {
  const ref = { courseId: r.course_id as string, labRoute: r.lab_route as string, stepId: r.step_id as string };
  return {
    id: r.id as string,
    anchor: anchorOf(r, ref),
    audience: r.audience === "everyone" ? { kind: "everyone" } : { kind: "student", learnerId: r.learner_id as string },
    body: r.body as string,
    authorId: r.author_id as string,
    createdAt: iso(r.created_at) as string,
    revokedAt: iso(r.revoked_at) ?? null
  };
}

function reflectionFromRow(r: Record<string, unknown>): Reflection {
  return {
    id: r.id as string,
    ref: { courseId: r.course_id as string, labRoute: r.lab_route as string, stepId: r.step_id as string },
    learnerId: r.learner_id as string,
    body: r.body as string,
    kind: isNoteKind(r.kind) ? r.kind : "note",
    sharedAt: iso(r.shared_at) as string
  };
}

const anchorId = (anchor: Anchor): string | null => (anchor.kind === "snippet" ? anchor.snippetId : anchor.kind === "reflection" ? anchor.reflectionId : null);

export function postgresFeedbackStore(sql: SqlClient): FeedbackStore {
  return {
    async annotate(annotation: NewAnnotation): Promise<Annotation> {
      const ref = annotation.anchor?.ref;
      if (!ref?.courseId || !annotation.authorId || !annotation.body) throw new Error("an annotation needs a step, an author and a body");
      const { rows } = await run("feedback_annotations insert", () =>
        sql.query(
          `INSERT INTO feedback_annotations (course_id, lab_route, step_id, anchor_kind, anchor_id, audience, learner_id, body, author_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz)
           RETURNING ${ANNOTATION}`,
          [
            ref.courseId,
            ref.labRoute,
            ref.stepId,
            annotation.anchor.kind,
            anchorId(annotation.anchor),
            annotation.audience.kind,
            annotation.audience.kind === "student" ? annotation.audience.learnerId : null,
            annotation.body,
            annotation.authorId,
            annotation.createdAt
          ]
        )
      );
      return annotationFromRow(rows[0]);
    },

    async get(id: string): Promise<Annotation | null> {
      if (!UUID.test(id)) return null;
      const { rows } = await run("feedback_annotations select", () => sql.query(`SELECT ${ANNOTATION} FROM feedback_annotations WHERE id = $1::uuid`, [id]));
      return rows[0] ? annotationFromRow(rows[0]) : null;
    },

    async forStep(ref: StepRef): Promise<Annotation[]> {
      const { rows } = await run("feedback_annotations step", () =>
        sql.query(`SELECT ${ANNOTATION} FROM feedback_annotations WHERE course_id = $1 AND lab_route = $2 AND step_id = $3 ORDER BY created_at, id`, [
          ref.courseId,
          ref.labRoute,
          ref.stepId
        ])
      );
      return rows.map(annotationFromRow);
    },

    async received(courseId: string, learnerId: string): Promise<Annotation[]> {
      if (!courseId || !learnerId) return [];
      const { rows } = await run("feedback_annotations received", () =>
        sql.query(
          `SELECT ${ANNOTATION} FROM feedback_annotations
           WHERE course_id = $1 AND revoked_at IS NULL AND (audience = 'everyone' OR learner_id = $2)
           ORDER BY created_at DESC, id DESC LIMIT 500`,
          [courseId, learnerId]
        )
      );
      return rows.map(annotationFromRow);
    },

    async revoke(id: string, at: string): Promise<Annotation | null> {
      if (!UUID.test(id)) return null;
      const { rows } = await run("feedback_annotations revoke", () =>
        sql.query(`UPDATE feedback_annotations SET revoked_at = COALESCE(revoked_at, $2::timestamptz) WHERE id = $1::uuid RETURNING ${ANNOTATION}`, [id, at])
      );
      return rows[0] ? annotationFromRow(rows[0]) : null;
    },

    async reflect(reflection: NewReflection): Promise<Reflection> {
      if (!reflection.ref?.courseId || !reflection.learnerId || !reflection.body) throw new Error("a reflection needs a step, a learner and a body");
      const { rows } = await run("feedback_reflections insert", () =>
        sql.query(
          `INSERT INTO feedback_reflections (course_id, lab_route, step_id, learner_id, kind, body, shared_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz) RETURNING ${REFLECTION}`,
          [reflection.ref.courseId, reflection.ref.labRoute, reflection.ref.stepId, reflection.learnerId, reflection.kind, reflection.body, reflection.sharedAt]
        )
      );
      return reflectionFromRow(rows[0]);
    },

    async reflections(courseId: string, learnerId: string): Promise<Reflection[]> {
      const { rows } = await run("feedback_reflections learner", () =>
        sql.query(`SELECT ${REFLECTION} FROM feedback_reflections WHERE course_id = $1 AND learner_id = $2 ORDER BY shared_at, id`, [courseId, learnerId])
      );
      return rows.map(reflectionFromRow);
    },

    async reflectionsAt(ref: StepRef): Promise<Reflection[]> {
      const { rows } = await run("feedback_reflections step", () =>
        sql.query(`SELECT ${REFLECTION} FROM feedback_reflections WHERE course_id = $1 AND lab_route = $2 AND step_id = $3 ORDER BY shared_at, id`, [
          ref.courseId,
          ref.labRoute,
          ref.stepId
        ])
      );
      return rows.map(reflectionFromRow);
    }
  };
}
