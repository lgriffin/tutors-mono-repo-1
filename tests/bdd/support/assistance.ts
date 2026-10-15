/**
 * The Assistance use cases composed over the in-memory adapters for one scenario: the store the
 * reader's server will write through, the feed the lecturers' tabs will watch, a clock the
 * scenario sets, and a recording publisher.
 */
import type { HelpKind } from "@tutors/domain/assistance";
import type { StepRef } from "@tutors/domain/learning";
import { acknowledgeHelp, answerHint, helpQueue, requestHelp, resolveHelp, withdrawHelp, type AssistanceDeps, type HelpCaller } from "../../../packages/application/src/index.ts";
import { FixedClock, InMemoryAssistanceFeed, InMemoryAssistanceStore, RecordingPublisher } from "../../../packages/application/src/testing/index.ts";

export function assistanceWorld() {
  const clock = new FixedClock();
  const store = new InMemoryAssistanceStore();
  const feed = new InMemoryAssistanceFeed();
  const publisher = new RecordingPublisher();
  const educators = new Set<string>();
  const deps: AssistanceDeps = { store, feed, clock, educatorsOf: async () => [...educators], publish: (e) => publisher.publish(e) };
  const actor = (login: string): HelpCaller => ({ login });
  return {
    clock,
    store,
    feed,
    publisher,
    educators,
    actor,
    ask: (ref: StepRef, kind: HelpKind, login: string, at: string) => {
      clock.set(at);
      return requestHelp(deps)(ref, kind, { login, name: login.toUpperCase() });
    },
    acknowledge: (id: string, login: string) => acknowledgeHelp(deps)(id, actor(login)),
    answerHint: (id: string, login: string, hint: string) => answerHint(deps)(id, actor(login), hint),
    resolve: (id: string, login: string) => resolveHelp(deps)(id, actor(login)),
    withdraw: (id: string, login: string) => withdrawHelp(deps)(id, actor(login)),
    queue: (courseId: string) => helpQueue(deps)(courseId)
  };
}

export type AssistanceWorld = ReturnType<typeof assistanceWorld>;
