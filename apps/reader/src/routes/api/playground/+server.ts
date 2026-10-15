import { error, json, type RequestHandler } from "@sveltejs/kit";
import type { WorkspaceFile } from "@tutors/domain/course/playground";
import { noContent, readJson, requireData, requireUser, valid } from "#lib/server/api/http.ts";
import { authorize } from "#lib/server/api/access.ts";
import * as check from "#lib/server/api/validate.ts";

/**
 * Playground hand-ins, kept by the reader's server with its service key (Rule 0475). The rules the
 * table's policies stated for a minted token now live here, decided from the session: a student
 * reads, saves and withdraws only their own snapshot; an educator of the course (enrollment.yaml or
 * PRIVATE_TUTORS_ADMINS, the `playground:view` permission) also reads every student's.
 */

const RUNTIMES = ["python", "javascript", "typescript"];
const MAX_BODY = 1024 * 1024;
const MAX_FILES = 64;

function filesOf(value: unknown): WorkspaceFile[] | null {
  if (!Array.isArray(value) || value.length > MAX_FILES) return null;
  const files = value.map((f) => (f && typeof f === "object" ? (f as Record<string, unknown>) : {}));
  if (files.some((f) => typeof f.path !== "string" || !f.path || f.path.length > 255 || typeof f.content !== "string")) return null;
  return files.map((f) => ({ path: f.path as string, content: f.content as string }));
}

/**
 * `?courseId=` answers whether the session reviews the course's hand-ins; with `&loId=` also the
 * snapshots of that exercise it may see; with `&studentId=` only that student's, which a student may
 * ask for only about themselves.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
  const user = await requireUser(locals);
  const courseId = valid(check.courseId(url.searchParams.get("courseId")), "courseId is required");
  const rawLo = url.searchParams.get("loId");
  const loId = rawLo === null ? null : valid(check.loRoute(rawLo), "loId is malformed");
  const rawStudent = url.searchParams.get("studentId");
  const studentId = rawStudent === null ? null : valid(check.text(rawStudent, 100), "studentId is malformed");
  const { playground } = requireData();
  const reviews = await authorize(user, "playground:view", { kind: "course", courseId });
  if (studentId && studentId !== user.login && !reviews) error(403, "Only an educator of this course can read another student's work");
  const snapshots = loId ? await playground.list(courseId, loId, reviews ? studentId : user.login) : [];
  return json({ reviews, snapshots }, { headers: { "cache-control": "private, no-store" } });
};

/** Hands in the session's own workspace; the student id and name come from the session, whatever the body says. */
export const PUT: RequestHandler = async ({ request, locals }) => {
  const user = await requireUser(locals);
  const body = await readJson(request, MAX_BODY);
  const courseId = valid(check.courseId(body.courseId), "courseId is required");
  const loId = valid(check.loRoute(body.loId), "loId is required");
  if (typeof body.runtime !== "string" || !RUNTIMES.includes(body.runtime)) error(400, `runtime is one of ${RUNTIMES.join(", ")}`);
  const entry = valid(check.text(body.entry, 255), "entry is required");
  const files = valid(filesOf(body.files), "files is a list of { path, content }");
  if (body.lastOutput !== undefined && typeof body.lastOutput !== "string") error(400, "lastOutput is text");
  if (body.lastOk !== undefined && body.lastOk !== null && typeof body.lastOk !== "boolean") error(400, "lastOk is true, false or null");
  const { playground } = requireData();
  await playground.save({
    studentId: user.login,
    studentName: user.name || user.login,
    courseId,
    loId,
    runtime: body.runtime,
    entry,
    files,
    lastOutput: (body.lastOutput as string | undefined) ?? "",
    lastOk: (body.lastOk as boolean | null | undefined) ?? null
  });
  return noContent();
};

/** Withdraws the session's own hand-in; nobody, an educator included, withdraws another student's. */
export const DELETE: RequestHandler = async ({ request, locals }) => {
  const user = await requireUser(locals);
  const body = await readJson(request);
  const courseId = valid(check.courseId(body.courseId), "courseId is required");
  const loId = valid(check.loRoute(body.loId), "loId is required");
  if (body.studentId !== undefined && body.studentId !== user.login) error(403, "Only the student who handed it in can withdraw a snapshot");
  const { playground } = requireData();
  await playground.remove(courseId, loId, user.login);
  return noContent();
};
