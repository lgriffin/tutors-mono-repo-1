import { json, error, type RequestHandler } from "@sveltejs/kit";
import type { MyStatus } from "@tutors/data-api";
import { SENTIMENTS, onlineStatusFor, parseSharing } from "@tutors/domain/presence";
import { noContent, readJson, requireData, requireUser } from "#lib/server/api/http.ts";
import * as check from "#lib/server/api/validate.ts";

type StatusChange = { sentiment?: string; sharing?: boolean };

function statusFrom(body: Record<string, unknown>): StatusChange {
  const status: StatusChange = {};
  if (body.sentiment !== undefined) {
    const sentiment = check.sentiment(body.sentiment, SENTIMENTS);
    if (!sentiment) error(400, "sentiment is not one of the course sentiments");
    status.sentiment = sentiment;
  }
  if (body.onlineStatus !== undefined) {
    const online = check.onlineStatus(body.onlineStatus);
    if (!online) error(400, 'onlineStatus is "online" or "offline"');
    status.sharing = parseSharing(online) ?? undefined;
  }
  return status;
}

/** The signed-in user's own sentiment and online status; the row is always the session's (Rule 0072). */
export const GET: RequestHandler = async ({ locals }) => {
  const user = await requireUser(locals);
  const { profile } = requireData();
  const [sentiment, sharing] = await Promise.all([profile.getSentiment(user.login), profile.getSharing(user.login)]);
  return json({ sentiment, online_status: sharing === null ? null : onlineStatusFor(sharing) } satisfies MyStatus);
};

/** On sign-in: the learner's record, with name, email and avatar from the session. */
export const PUT: RequestHandler = async ({ request, locals }) => {
  const user = await requireUser(locals);
  const status = statusFrom(await readJson(request));
  await requireData().profile.upsertLearner({
    login: user.login,
    name: user.name,
    email: user.email,
    image: user.image,
    sentiment: status.sentiment ?? null,
    sharing: status.sharing ?? null
  });
  return noContent();
};

export const PATCH: RequestHandler = async ({ request, locals }) => {
  const user = await requireUser(locals);
  const status = statusFrom(await readJson(request));
  if (!status.sentiment && status.sharing === undefined) error(400, "sentiment or onlineStatus is required");
  const { profile } = requireData();
  if (status.sentiment) await profile.setSentiment(user.login, status.sentiment as (typeof SENTIMENTS)[number]);
  if (status.sharing !== undefined) await profile.setSharing(user.login, status.sharing);
  return noContent();
};
