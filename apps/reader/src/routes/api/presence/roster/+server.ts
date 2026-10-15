import type { RequestHandler } from "@sveltejs/kit";
import { readerServer } from "#lib/server/api/adapters.ts";
import { answer, publicReadHeaders } from "#lib/server/api/cors.ts";
import * as check from "#lib/server/api/validate.ts";

/**
 * The stored presence roster for Tutors Live (Rule 0471): the latest snapshot each student chose to
 * share, in one course (`courseId`) or the most recent across every course, received since `since`
 * when given. It is what the students shared, so any origin may read it; 503 without the service key
 * (Rule 0474).
 */
export const GET: RequestHandler = async ({ url }) => {
  const cors = publicReadHeaders();
  const rawCourse = url.searchParams.get("courseId");
  const courseId = rawCourse === null ? null : check.courseId(rawCourse);
  if (rawCourse !== null && !courseId) return answer(400, { message: "courseId is malformed" }, cors);
  const since = url.searchParams.get("since");
  if (since !== null && !Number.isFinite(Date.parse(since))) return answer(400, { message: "since is not a timestamp" }, cors);
  const { data } = readerServer();
  if (!data) return answer(503, { message: "Presence is not configured on this server" }, cors);
  const rows = await data.roster(courseId, since === null ? null : new Date(since).toISOString());
  if (!rows) return answer(500, { message: "The roster could not be read" }, cors);
  return answer(200, { rows }, cors);
};
