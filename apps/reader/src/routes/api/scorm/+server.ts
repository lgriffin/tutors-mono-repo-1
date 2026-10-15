import { error, json, type RequestHandler } from "@sveltejs/kit";
import { noContent, readJson, requireData, requireUser, valid } from "#lib/server/api/http.ts";
import * as check from "#lib/server/api/validate.ts";

const VERSIONS = ["1.2", "2004"];
const MAX_CMI_KEYS = 4096;

function cmiOf(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_CMI_KEYS || entries.some(([key, v]) => key.length > 255 || typeof v !== "string")) return null;
  return value as Record<string, string>;
}

const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** The signed-in learner's saved SCORM state for one learning object (Rule 0473): their own, never anyone else's. */
export const GET: RequestHandler = async ({ url, locals }) => {
  const user = await requireUser(locals);
  const courseId = valid(check.courseId(url.searchParams.get("courseId")), "courseId is required");
  const loId = valid(check.loRoute(url.searchParams.get("loId")), "loId is required");
  const { scorm } = requireData();
  return json({ cmi: await scorm.load(courseId, user.login, loId) }, { headers: { "cache-control": "private, no-store" } });
};

/** Saves the learner's attempt under the session's login, whatever the body names. */
export const PUT: RequestHandler = async ({ request, locals }) => {
  const user = await requireUser(locals);
  const body = await readJson(request, 512 * 1024);
  const courseId = valid(check.courseId(body.courseId), "courseId is required");
  const loId = valid(check.loRoute(body.loId), "loId is required");
  if (typeof body.version !== "string" || !VERSIONS.includes(body.version)) error(400, "version is 1.2 or 2004");
  const cmi = valid(cmiOf(body.cmi), "cmi is an object of strings");
  const summary = (body.summary ?? {}) as Record<string, unknown>;
  const { scorm } = requireData();
  await scorm.save({
    courseId,
    learnerId: user.login,
    loId,
    version: body.version as "1.2" | "2004",
    cmi,
    summary: {
      completionStatus: check.text(summary.completionStatus, 32) ?? "unknown",
      successStatus: check.text(summary.successStatus, 32) ?? "unknown",
      scoreRaw: number(summary.scoreRaw),
      scoreMin: number(summary.scoreMin),
      scoreMax: number(summary.scoreMax),
      scoreScaled: number(summary.scoreScaled),
      totalTime: number(summary.totalTime) ?? 0,
      location: typeof summary.location === "string" ? summary.location.slice(0, 1000) : ""
    }
  });
  return noContent();
};
