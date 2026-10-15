/**
 * The reader server's side of help requests (the Assistance context): the use cases over the
 * Postgres AssistanceStore and the Valkey AssistanceFeed the composition root picked, the course's
 * educators from its published enrollment, and the parsing of what a browser posts to
 * /api/assistance. Every write runs here, as the session's actor (Rule 0390); a browser only asks.
 */
import { clock } from "@tutors/clock";
import { acknowledgeHelp, answerHint, helpQueue, myHelpRequest, requestHelp, resolveHelp, withdrawHelp, type AssistanceDeps, type HelpRefusal } from "@tutors/application";
import { stepRef, type StepRef } from "@tutors/domain/learning";
import { readerServer } from "./api/adapters.ts";
import { educatorsOf } from "./snippets.ts";

/** The longest hint a lecturer may type. */
export const MAX_HINT_LENGTH = 2000;

/** The use cases over this server's adapters, or null when it keeps no help requests (anonymous mode, or not on Postgres). */
export function assistance(fetchFn: typeof fetch) {
  const { data, realtime } = readerServer();
  if (!data?.assistance) return null;
  const deps: AssistanceDeps = { store: data.assistance, feed: realtime.assistance, clock, educatorsOf: (courseId) => educatorsOf(courseId, (url) => fetchFn(url)) };
  return {
    request: requestHelp(deps),
    acknowledge: acknowledgeHelp(deps),
    answerHint: answerHint(deps),
    resolve: resolveHelp(deps),
    withdraw: withdrawHelp(deps),
    queue: helpQueue(deps),
    mine: myHelpRequest(deps),
    educatorsOf: deps.educatorsOf
  };
}

/** What a browser posts: a student asking on a step, or anyone acting on a request by id. */
export type HelpPost =
  { action: "request"; ref: StepRef; kind: string } | { action: "acknowledge" | "resolve" | "withdraw"; id: string } | { action: "answer-hint"; id: string; hintText: string };

const text = (value: unknown, max: number): string | null => (typeof value === "string" && value.trim() && value.length <= max ? value.trim() : null);

/** The post, or why it is malformed. */
export function parseHelpPost(body: Record<string, unknown>): HelpPost | string {
  switch (body.action) {
    case "request": {
      const ref = stepRef(text(body.courseId, 200), text(body.labRoute, 512), text(body.stepId, 200));
      if (!ref) return "courseId, labRoute and stepId are required";
      if (!ref.labRoute.startsWith(`/lab/${ref.courseId}/`)) return "labRoute is a lab of the course, /lab/<courseId>/...";
      if (typeof body.kind !== "string") return "kind is one of stuck, hint, lecturer";
      return { action: "request", ref, kind: body.kind };
    }
    case "acknowledge":
    case "resolve":
    case "withdraw":
    case "answer-hint": {
      const id = text(body.id, 64);
      if (!id) return "id is required";
      if (body.action !== "answer-hint") return { action: body.action, id };
      const hintText = typeof body.hintText === "string" ? body.hintText : "";
      if (hintText.length > MAX_HINT_LENGTH) return `a hint is at most ${MAX_HINT_LENGTH} characters`;
      return { action: "answer-hint", id, hintText };
    }
    default:
      return "action is one of request, acknowledge, answer-hint, resolve, withdraw";
  }
}

/** The status and message each refusal answers with. */
export const HELP_REFUSALS: Record<HelpRefusal, { status: number; message: string }> = {
  invalid: { status: 400, message: "That is not a help request tutors can open" },
  "hint-required": { status: 400, message: "Type a hint to answer a Need-a-hint request" },
  "not-permitted": { status: 403, message: "Only an educator of the course, or the student who asked, may do that" },
  "not-found": { status: 404, message: "No such help request" },
  conflict: { status: 409, message: "The request changed at the same moment; read it again" },
  "not-in-state-table": { status: 409, message: "The request has already moved on" },
  unavailable: { status: 503, message: "The help request was not sent; try again" }
};
