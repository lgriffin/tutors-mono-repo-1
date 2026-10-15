/**
 * The HelpDesk port in memory: the Assistance use cases themselves, run as a signed-in actor over
 * the in-memory store and feed, as the reader's server runs them over Postgres and Valkey. Desks
 * made with `as` share the store, the feed and the clock, so a student's desk and a lecturer's desk
 * see the same requests. With no actor every ask is refused as `signed-out`, as the anonymous
 * reader's would be.
 */
import { isEducatorOf } from "@tutors/domain/access";
import type { HelpKind, HelpRequest } from "@tutors/domain/assistance";
import type { StepRef } from "@tutors/domain/learning";
import { acknowledgeHelp, answerHint, helpQueue, myHelpRequest, rateHelp, requestHelp, resolveHelp, withdrawHelp, type AssistanceDeps, type HelpResult } from "../assistance/help.ts";
import type { Clock } from "../ports/clock.ts";
import type { HelpDesk, HelpDeskResult } from "../ports/help-desk.ts";
import { FixedClock } from "./in-memory.ts";
import { InMemoryAssistanceFeed, InMemoryAssistanceStore } from "./learning-contexts.ts";

export type HelpDeskActor = { login: string; name: string | null };

export type InMemoryHelpDeskOptions = {
  store?: InMemoryAssistanceStore;
  feed?: InMemoryAssistanceFeed;
  clock?: Clock;
  /** Each course's educator logins. */
  educators?: Record<string, string[]>;
  actor?: HelpDeskActor | null;
};

export class InMemoryHelpDesk implements HelpDesk {
  readonly store: InMemoryAssistanceStore;
  readonly feed: InMemoryAssistanceFeed;
  readonly clock: Clock;
  readonly educators: Record<string, string[]>;
  readonly actor: HelpDeskActor | null;
  /** How many times each method was called, for a test that counts reads. */
  readonly calls = { ask: 0, act: 0, answerHint: 0, rate: 0, mine: 0, queue: 0 };

  constructor(options: InMemoryHelpDeskOptions = {}) {
    this.store = options.store ?? new InMemoryAssistanceStore();
    this.feed = options.feed ?? new InMemoryAssistanceFeed();
    this.clock = options.clock ?? new FixedClock();
    this.educators = options.educators ?? {};
    this.actor = options.actor ?? null;
  }

  /** A desk over the same requests, signed in as someone else (or nobody). */
  as(actor: HelpDeskActor | null): InMemoryHelpDesk {
    return new InMemoryHelpDesk({ store: this.store, feed: this.feed, clock: this.clock, educators: this.educators, actor });
  }

  private deps(): AssistanceDeps {
    return { store: this.store, feed: this.feed, clock: this.clock, educatorsOf: async (courseId) => this.educators[courseId] ?? [] };
  }

  private static answer(result: HelpResult): HelpDeskResult {
    return result.ok ? { ok: true, request: result.request } : { ok: false, reason: result.reason };
  }

  async ask(ref: StepRef, kind: HelpKind): Promise<HelpDeskResult> {
    this.calls.ask++;
    if (!this.actor) return { ok: false, reason: "signed-out" };
    return InMemoryHelpDesk.answer(await requestHelp(this.deps())(ref, kind, this.actor));
  }

  async act(id: string, action: "acknowledge" | "resolve" | "withdraw"): Promise<HelpDeskResult> {
    this.calls.act++;
    if (!this.actor) return { ok: false, reason: "signed-out" };
    const run = action === "acknowledge" ? acknowledgeHelp : action === "resolve" ? resolveHelp : withdrawHelp;
    return InMemoryHelpDesk.answer(await run(this.deps())(id, { login: this.actor.login }));
  }

  async answerHint(id: string, hintText: string): Promise<HelpDeskResult> {
    this.calls.answerHint++;
    if (!this.actor) return { ok: false, reason: "signed-out" };
    return InMemoryHelpDesk.answer(await answerHint(this.deps())(id, { login: this.actor.login }, hintText));
  }

  async rate(id: string, helped: boolean): Promise<HelpDeskResult> {
    this.calls.rate++;
    if (!this.actor) return { ok: false, reason: "signed-out" };
    return InMemoryHelpDesk.answer(await rateHelp(this.deps())(id, { login: this.actor.login }, helped));
  }

  async mine(courseId: string): Promise<HelpRequest | null> {
    this.calls.mine++;
    if (!this.actor) return null;
    return myHelpRequest(this.deps())(courseId, this.actor.login);
  }

  async queue(courseId: string): Promise<HelpRequest[]> {
    this.calls.queue++;
    if (!this.actor || !isEducatorOf(this.actor.login, { educators: this.educators[courseId] ?? [] })) throw new Error("only an educator of the course reads its queue");
    return (await helpQueue(this.deps())(courseId)).map((entry) => entry.request);
  }
}
