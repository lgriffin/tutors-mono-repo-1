/**
 * The help-request use cases: a student asks, asks again or withdraws; a lecturer acknowledges,
 * answers a hint or resolves; the queue is read with waiting time from the clock and forgotten
 * requests withdrawn on read (decision D6), so nothing needs a scheduler. Each change is told to
 * the course's watchers through AssistanceFeed; a feed that fails does not undo the change.
 */
import {
  askAgain,
  awaitsRating,
  EXPIRE_AFTER_MS,
  isHelpKind,
  isLive,
  openRequest,
  queueOrder,
  rateHelp as rate,
  shouldEscalate,
  shouldExpire,
  transition,
  waitingMs,
  type Escalation,
  type HelpAction,
  type HelpActor,
  type HelpKind,
  type HelpRequest,
  type TransitionRefusal
} from "@tutors/domain/assistance";
import { isEducatorOf } from "@tutors/domain/access";
import { isStepRef, type StepRef } from "@tutors/domain/learning";
import type { AssistanceFeed } from "../ports/assistance-feed.ts";
import type { AssistanceStore } from "../ports/assistance-store.ts";
import type { Clock } from "../ports/clock.ts";
import type { EventPublisher } from "../ports/event-publisher.ts";

export type AssistanceDeps = {
  store: AssistanceStore;
  feed: AssistanceFeed;
  clock: Clock;
  /** The course's educator logins; whether a caller acts as the educator is decided here, never by the caller. */
  educatorsOf: (courseId: string) => Promise<string[]>;
  publish?: EventPublisher["publish"];
};

export type HelpRefusal = "invalid" | "unavailable" | "not-found" | "conflict" | TransitionRefusal;
export type HelpResult = { ok: true; request: HelpRequest } | { ok: false; reason: HelpRefusal };

const iso = (clock: Clock) => clock.now().toISOString();

/**
 * Withdraws, as the system, the live requests that have waited 4 hours and tells the course's
 * watchers; resolves the ones still live. A request whose withdrawal was not stored stays live,
 * so what the queue shows is what the store holds.
 */
async function expireStale({ store, feed, clock }: Pick<AssistanceDeps, "store" | "feed" | "clock">, requests: HelpRequest[]): Promise<HelpRequest[]> {
  const now = clock.nowMs();
  const live: HelpRequest[] = [];
  for (const request of requests) {
    if (!shouldExpire(request, now)) {
      live.push(request);
      continue;
    }
    const moved = transition(request, "expire", "system", iso(clock));
    if (!moved.ok) continue;
    const kept = await store.replace(moved.request, request).catch(() => false);
    if (kept) await feed.publish({ type: "help-request", courseId: request.ref.courseId, request: moved.request }).catch(() => false);
    else live.push(request);
  }
  return live;
}

/**
 * A signed-in student asks for help on a step (Rule 0385). While one of their requests in the
 * course is live, asking again changes its kind and step and keeps its time (Rule 0386).
 */
export function requestHelp({ store, feed, clock, publish }: Pick<AssistanceDeps, "store" | "feed" | "clock" | "publish">) {
  return async (ref: StepRef, kind: HelpKind, learner: { login: string; name: string | null }): Promise<HelpResult> => {
    if (!learner.login || !isHelpKind(kind) || !isStepRef(ref)) return { ok: false, reason: "invalid" };
    let request: HelpRequest | undefined;
    try {
      const live = await expireStale({ store, feed, clock }, await store.live(ref.courseId));
      const mine = live.find((r) => r.learnerId === learner.login);
      if (mine) {
        request = askAgain(mine, ref, kind);
        if (!(await store.replace(request, mine))) return { ok: false, reason: "conflict" };
      }
    } catch {
      return { ok: false, reason: "unavailable" };
    }
    if (!request) {
      try {
        request = await store.open(openRequest(ref, learner, kind, iso(clock)));
      } catch {
        // A durable store refuses a second live request (its unique index): another of the learner's
        // tabs asked at the same moment, and theirs was kept. Anything else means nothing was kept.
        const raced = await store
          .live(ref.courseId)
          .then((live) => live.some((r) => r.learnerId === learner.login))
          .catch(() => false);
        return { ok: false, reason: raced ? "conflict" : "unavailable" };
      }
    }
    await feed.publish({ type: "help-request", courseId: ref.courseId, request }).catch(() => false);
    await publish?.({ type: "help-requested", request });
    return { ok: true, request };
  };
}

/** Who is acting: their signed-in login. Whether they are the course's educator is looked up, not taken from them. */
export type HelpCaller = { login: string };

function act(action: HelpAction, { store, feed, clock, educatorsOf, publish }: AssistanceDeps) {
  return async (id: string, caller: HelpCaller, hintText?: string): Promise<HelpResult> => {
    let current: HelpRequest | null;
    let educators: string[];
    try {
      current = await store.get(id);
      if (!current) return { ok: false, reason: "not-found" };
      educators = await educatorsOf(current.ref.courseId);
    } catch {
      return { ok: false, reason: "unavailable" };
    }
    if (shouldExpire(current, clock.nowMs())) {
      await expireStale({ store, feed, clock }, [current]);
      return { ok: false, reason: "not-in-state-table" };
    }
    const actor: HelpActor = { login: caller.login, educator: isEducatorOf(caller.login, { educators }) };
    const moved = transition(current, action, actor, iso(clock), hintText);
    if (!moved.ok) return moved;
    const kept = await store.replace(moved.request, current).catch(() => null);
    if (kept === null) return { ok: false, reason: "unavailable" };
    if (!kept) return { ok: false, reason: "conflict" };
    await feed.publish({ type: "help-request", courseId: moved.request.ref.courseId, request: moved.request }).catch(() => false);
    if (action === "answer-hint" || (action === "resolve" && actor.educator)) await publish?.({ type: "help-answered", request: moved.request });
    return moved;
  };
}

/** A lecturer says they are on the way. */
export const acknowledgeHelp = (deps: AssistanceDeps) => {
  const run = act("acknowledge", deps);
  return (id: string, caller: HelpCaller) => run(id, caller);
};

/** A lecturer answers a Need-a-hint request with a typed hint, which resolves it as helped by a hint (decision D4). */
export const answerHint = (deps: AssistanceDeps) => {
  const run = act("answer-hint", deps);
  return (id: string, caller: HelpCaller, hintText: string) => run(id, caller, hintText);
};

/** The lecturer, or the student who asked ("Solved"), ends the request. */
export const resolveHelp = (deps: AssistanceDeps) => {
  const run = act("resolve", deps);
  return (id: string, caller: HelpCaller) => run(id, caller);
};

/** The student who asked takes the request back. */
export const withdrawHelp = (deps: AssistanceDeps) => {
  const run = act("withdraw", deps);
  return (id: string, caller: HelpCaller) => run(id, caller);
};

/**
 * The student who asked says whether the help helped, once the request is resolved (Rule 0398).
 * The answer is kept on the request; the queue does not hear of it, as the request has left it.
 */
export function rateHelp({ store }: Pick<AssistanceDeps, "store">) {
  return async (id: string, caller: HelpCaller, helped: boolean): Promise<HelpResult> => {
    if (typeof helped !== "boolean") return { ok: false, reason: "invalid" };
    let current: HelpRequest | null;
    try {
      current = await store.get(id);
    } catch {
      return { ok: false, reason: "unavailable" };
    }
    if (!current) return { ok: false, reason: "not-found" };
    const rated = rate(current, { login: caller.login, educator: false }, helped);
    if (!rated.ok) return rated;
    const kept = await store.replace(rated.request, current).catch(() => null);
    if (kept === null) return { ok: false, reason: "unavailable" };
    if (!kept) return { ok: false, reason: "conflict" };
    return rated;
  };
}

/**
 * The student's own request in the course, or null, read from stored rows: a student's reader never
 * streams the course's queue (Rule 0392). That is their live request; or, once none is live, their
 * latest one if it was resolved in the last 4 hours, so the reader can show a lecturer's hint on the
 * step (Rule 0397) and ask whether it helped (Rule 0398). A request that has waited 4 hours is
 * withdrawn on the way, as the queue does.
 */
export function myHelpRequest({ store, feed, clock }: Pick<AssistanceDeps, "store" | "feed" | "clock">) {
  return async (courseId: string, login: string): Promise<HelpRequest | null> => {
    const live = await expireStale({ store, feed, clock }, await store.live(courseId));
    const mine = live.find((r) => r.learnerId === login);
    if (mine) return mine;
    const latest = await store.latest(courseId, login);
    if (!latest || latest.state !== "resolved" || !latest.closed) return null;
    const recent = clock.nowMs() - Date.parse(latest.closed.at) < EXPIRE_AFTER_MS;
    return recent && (awaitsRating(latest) || latest.hintText) ? latest : null;
  };
}

/** One row of the lecturer's queue: the request, how long it has waited at this instant, and its escalation. */
export type QueueEntry = { request: HelpRequest; waitingMs: number; escalation: Escalation };

/**
 * The course's live requests in queue order, each with its waiting time and escalation from the
 * clock (Rules 0387, 0388); requests that have waited 4 hours are withdrawn on the way.
 */
export function helpQueue({ store, feed, clock }: Pick<AssistanceDeps, "store" | "feed" | "clock">) {
  return async (courseId: string): Promise<QueueEntry[]> => {
    const live = (await expireStale({ store, feed, clock }, await store.live(courseId))).filter(isLive).sort(queueOrder);
    const now = clock.nowMs();
    return live.map((request) => ({ request, waitingMs: waitingMs(request, now), escalation: shouldEscalate(request, now) }));
  };
}
