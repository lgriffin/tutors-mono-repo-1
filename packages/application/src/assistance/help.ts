/**
 * The help-request use cases: a student asks, asks again or withdraws; a lecturer acknowledges,
 * answers a hint or resolves; the queue is read with waiting time from the clock and forgotten
 * requests withdrawn on read (decision D6), so nothing needs a scheduler. Each change is told to
 * the course's watchers through AssistanceFeed; a feed that fails does not undo the change.
 */
import {
  askAgain,
  isHelpKind,
  isLive,
  openRequest,
  queueOrder,
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
import type { StepRef } from "@tutors/domain/learning";
import type { AssistanceFeed } from "../ports/assistance-feed.ts";
import type { AssistanceStore } from "../ports/assistance-store.ts";
import type { Clock } from "../ports/clock.ts";
import type { EventPublisher } from "../ports/event-publisher.ts";

export type AssistanceDeps = {
  store: AssistanceStore;
  feed: AssistanceFeed;
  clock: Clock;
  publish?: EventPublisher["publish"];
};

export type HelpRefusal = "invalid" | "unavailable" | "not-found" | "conflict" | TransitionRefusal;
export type HelpResult = { ok: true; request: HelpRequest } | { ok: false; reason: HelpRefusal };

const iso = (clock: Clock) => clock.now().toISOString();

/** Withdraws, as the system, the live requests that have waited 4 hours; resolves the ones still live. */
async function expireStale(store: AssistanceStore, clock: Clock, requests: HelpRequest[]): Promise<HelpRequest[]> {
  const now = clock.nowMs();
  const live: HelpRequest[] = [];
  for (const request of requests) {
    if (!shouldExpire(request, now)) {
      live.push(request);
      continue;
    }
    const moved = transition(request, "expire", "system", iso(clock));
    if (moved.ok) await store.replace(moved.request, request.state).catch(() => false);
  }
  return live;
}

/**
 * A signed-in student asks for help on a step (Rule 0385). While one of their requests in the
 * course is live, asking again changes its kind and step and keeps its time (Rule 0386).
 */
export function requestHelp({ store, feed, clock, publish }: AssistanceDeps) {
  return async (ref: StepRef, kind: HelpKind, learner: { login: string; name: string | null }): Promise<HelpResult> => {
    if (!learner.login || !isHelpKind(kind)) return { ok: false, reason: "invalid" };
    let request: HelpRequest;
    try {
      const live = await expireStale(store, clock, await store.live(ref.courseId));
      const mine = live.find((r) => r.learnerId === learner.login);
      if (mine) {
        request = askAgain(mine, ref, kind);
        if (!(await store.replace(request, mine.state))) return { ok: false, reason: "conflict" };
      } else {
        request = await store.open(openRequest(ref, learner, kind, iso(clock)));
      }
    } catch {
      return { ok: false, reason: "unavailable" };
    }
    await feed.publish({ type: "help-request", courseId: ref.courseId, request }).catch(() => false);
    await publish?.({ type: "help-requested", request });
    return { ok: true, request };
  };
}

function act(action: HelpAction, { store, feed, clock, publish }: AssistanceDeps) {
  return async (id: string, actor: HelpActor, hintText?: string): Promise<HelpResult> => {
    let current: HelpRequest | null;
    try {
      current = await store.get(id);
    } catch {
      return { ok: false, reason: "unavailable" };
    }
    if (!current) return { ok: false, reason: "not-found" };
    if (shouldExpire(current, clock.nowMs())) {
      await expireStale(store, clock, [current]);
      return { ok: false, reason: "not-in-state-table" };
    }
    const moved = transition(current, action, actor, iso(clock), hintText);
    if (!moved.ok) return moved;
    const kept = await store.replace(moved.request, current.state).catch(() => null);
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
  return (id: string, actor: HelpActor) => run(id, actor);
};

/** A lecturer answers a Need-a-hint request with a typed hint, which resolves it as helped by a hint (decision D4). */
export const answerHint = (deps: AssistanceDeps) => {
  const run = act("answer-hint", deps);
  return (id: string, actor: HelpActor, hintText: string) => run(id, actor, hintText);
};

/** The lecturer, or the student who asked ("Solved"), ends the request. */
export const resolveHelp = (deps: AssistanceDeps) => {
  const run = act("resolve", deps);
  return (id: string, actor: HelpActor) => run(id, actor);
};

/** The student who asked takes the request back. */
export const withdrawHelp = (deps: AssistanceDeps) => {
  const run = act("withdraw", deps);
  return (id: string, actor: HelpActor) => run(id, actor);
};

/** One row of the lecturer's queue: the request, how long it has waited at this instant, and its escalation. */
export type QueueEntry = { request: HelpRequest; waitingMs: number; escalation: Escalation };

/**
 * The course's live requests in queue order, each with its waiting time and escalation from the
 * clock (Rules 0387, 0388); requests that have waited 4 hours are withdrawn on the way.
 */
export function helpQueue({ store, clock }: Pick<AssistanceDeps, "store" | "clock">) {
  return async (courseId: string): Promise<QueueEntry[]> => {
    const live = (await expireStale(store, clock, await store.live(courseId))).filter(isLive).sort(queueOrder);
    const now = clock.nowMs();
    return live.map((request) => ({ request, waitingMs: waitingMs(request, now), escalation: shouldEscalate(request, now) }));
  };
}
