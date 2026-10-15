import log from "@tutors/logger";
import { opaqueUid, serviceForLoType, type Service } from "@tutors/domain/live";
import { adapters } from "../../adapters.ts";

/**
 * The reader's connection to Tutors Live.
 *
 * It is deliberately separate from the analytics and presence services: those
 * need a learner record and stop dead in anonymous mode, while live events carry
 * no identity and are the same whether or not anyone is signed in. That is the
 * whole point of the model - the dashboard counts everybody, and knows who
 * nobody is.
 *
 * Which reporter sits behind this is the composition root's decision: the HTTP
 * reporter with `PUBLIC_LIVE_EVENTS_URL` set, or the disabled recording one,
 * in which case every call below is a no-op.
 */

/**
 * Records that a signed-in learner has opted in to being counted as returning.
 * Hashing is asynchronous, so the identifier joins the next session rather than
 * the one already open - which is the conservative order to get it in.
 */
export async function optInToLiveEvents(login: string): Promise<void> {
  const reporter = adapters().liveEvents;
  if (!reporter.enabled || !login) return;
  try {
    reporter.identify(await opaqueUid(login));
  } catch (error) {
    log.debug("live events could not hash the learner", { error: String(error) });
  }
}

/** Drops the identifier. The learner's earlier events are purged server-side. */
export function optOutOfLiveEvents(): void {
  adapters().liveEvents.identify(undefined);
}

/** A course was opened. Starts the session if this is the first one. */
export function reportCourseOpened(courseId: string): void {
  adapters().liveEvents.courseOpened(courseId);
}

/**
 * A learning object was opened: one `lo.viewed`, plus a `service.used` when the
 * type maps onto a catalogued service.
 */
export function reportLoViewed(courseId: string, route: string, loType: string): void {
  const reporter = adapters().liveEvents;
  if (!reporter.enabled || !courseId || !route) return;
  reporter.loViewed(courseId, route, loType);
  const service = serviceForLoType(loType);
  if (service) reporter.serviceUsed(courseId, service);
}

/** A named service was used directly, for the ones no learning object type implies. */
export function reportServiceUsed(courseId: string, service: Service): void {
  adapters().liveEvents.serviceUsed(courseId, service);
}

/**
 * Starts the heartbeat and the page-hide flush.
 * @returns a function that stops both, for the caller's teardown.
 */
export function startLiveEvents(course: () => string | undefined, lo: () => string | undefined): () => void {
  return adapters().liveEvents.start(course, lo);
}
