import { error, type RequestHandler } from "@sveltejs/kit";
import { SENTIMENTS } from "@tutors/domain/presence";
import { noContent, readJson, requireData, requireUser, valid } from "#lib/server/api/http.ts";
import * as check from "#lib/server/api/validate.ts";

/** The learning object a sharing student is on, kept as their latest snapshot under the session's login (Rule 0072). */
export const POST: RequestHandler = async ({ request, locals }) => {
  const user = await requireUser(locals);
  const body = await readJson(request, 16 * 1024);
  const courseId = valid(check.courseId(body.courseId), "courseId is required");
  const payload = body.payload as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) error(400, "payload is required");
  if (payload.courseId !== courseId) error(400, "payload.courseId must be the course");
  const sent = (payload.user ?? {}) as { sentiment?: unknown };
  const record: Record<string, unknown> = {
    courseId,
    courseUrl: check.text(payload.courseUrl, 300),
    courseTitle: check.text(payload.courseTitle, 300),
    title: check.text(payload.title, 300),
    loRoute: check.loRoute(payload.loRoute),
    type: check.loType(payload.type),
    img: check.imageUrl(payload.img),
    isPrivate: payload.isPrivate === true,
    user: {
      id: user.login,
      fullName: user.name ?? user.login,
      avatar: user.image ?? "",
      sentiment: check.sentiment(sent.sentiment, SENTIMENTS) ?? "neutral"
    }
  };
  const icon = check.icon(payload.icon);
  if (icon) record.icon = icon;
  for (const key of Object.keys(record)) if (record[key] === null) delete record[key];
  await requireData().storePresence(user.login, courseId, record);
  return noContent();
};
