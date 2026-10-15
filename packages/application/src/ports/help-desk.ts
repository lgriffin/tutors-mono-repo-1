/**
 * What a page asks of help requests, as the person signed in to it: a student asks, withdraws,
 * marks solved and says whether it helped; a lecturer reads the course's queue and acknowledges,
 * answers a hint or resolves. The browser never keeps or moves a request itself: an adapter sends
 * each ask to whoever runs the Assistance use cases as the session's actor (the reader's server,
 * POST /api/assistance, Rule 0390) and answers with what was kept.
 */
import type { HelpKind, HelpRequest } from "@tutors/domain/assistance";
import type { StepRef } from "@tutors/domain/learning";

/**
 * Why an ask was not kept: the Assistance use cases' refusals, plus `signed-out` (nobody is signed
 * in, or the deployment has no sign-in) and `not-kept` (the deployment keeps no help requests).
 */
export type HelpDeskRefusal =
  | "invalid"
  | "unavailable"
  | "not-found"
  | "conflict"
  | "not-in-state-table"
  | "not-permitted"
  | "hint-required"
  | "signed-out"
  | "not-kept";

export type HelpDeskResult = { ok: true; request: HelpRequest } | { ok: false; reason: HelpDeskRefusal };

export interface HelpDesk {
  /** Asks for help on a step, or asks again with another kind or step (Rules 0385, 0386). */
  ask(ref: StepRef, kind: HelpKind): Promise<HelpDeskResult>;
  /** Moves a request by id: an educator acknowledges or resolves, the student who asked withdraws or resolves. */
  act(id: string, action: "acknowledge" | "resolve" | "withdraw"): Promise<HelpDeskResult>;
  /** An educator answers a Need-a-hint request with a typed hint (decision D4). */
  answerHint(id: string, hintText: string): Promise<HelpDeskResult>;
  /** The student who asked says whether a resolved request helped (Rule 0398). */
  rate(id: string, helped: boolean): Promise<HelpDeskResult>;
  /** The signed-in student's own request in the course (live, or just resolved), or null; rejects when it could not be read. */
  mine(courseId: string): Promise<HelpRequest | null>;
  /** The course's live requests, for an educator of the course; rejects when they could not be read or the caller may not read them. */
  queue(courseId: string): Promise<HelpRequest[]>;
}
