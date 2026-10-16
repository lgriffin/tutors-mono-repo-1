/**
 * A lecturer's help queue in Tutors Live: the course's live help requests with the student, the lab
 * and step, the kind of help and the waiting time ticking each second (Rule 0395), lecturer requests
 * first and then the longest waiting (Rule 0396), and the lecturer's actions on them: acknowledge,
 * answer a hint request with a typed hint, resolve.
 *
 * The queue is read from stored rows through the HelpDesk (GET /api/assistance, educators only) and
 * read again every QUEUE_REFRESH_MS; where the deployment streams the course's queue
 * (AssistanceFeed, Valkey) each change shows at once between reads. A read that fails keeps the
 * queue on screen and says when it was last read (Rule 0393).
 *
 * A request the lecturer resolves here is offered as an explanation for everyone on its step,
 * pre-filled with the step and any hint (Rule 0407), posted through the FeedbackDesk; that offer is
 * the only link from Assistance to Feedback. Explanations broadcast on the course, from here or
 * from the reader, show as they are heard on the stream (Rule 0405).
 */
import { isLive, queueOrder, shouldEscalate, waitingMs, type Escalation, type HelpRequest } from "@tutors/domain/assistance";
import { isBroadcast, isRevoked, type Annotation } from "@tutors/domain/feedback";
import type { StepRef } from "@tutors/domain/learning";
import type { HelpDeskRefusal, HelpDeskResult, Unsubscribe } from "@tutors/application/ports";
import { adapters } from "../adapters.ts";
import { rune } from "../index.svelte.ts";

/** How often the queue is read from stored rows, stream or no stream. */
export const QUEUE_REFRESH_MS = 60_000;
const TICK_MS = 1_000;

/** Where a request was asked from, as the queue names it: the lab's last route segment and the step. */
export type QueuePlace = { lab: string; step: string };

/** One row of the queue as a lecturer sees it now. */
export type QueueRow = { request: HelpRequest; waitingMs: number; escalation: Escalation; online: boolean; where: QueuePlace };

/** Decoded for reading; a malformed escape shows as stored rather than breaking the queue (Rule 0563). */
function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

export function placeOf(ref: StepRef): QueuePlace {
  return { lab: decoded(ref.labRoute.split("/").filter(Boolean).pop() ?? ref.labRoute), step: decoded(ref.stepId) };
}

function createHelpQueueService() {
  const courseId = rune<string | null>(null);
  const requests = rune<HelpRequest[]>([]);
  /** The clock, read each second so waiting times move. */
  const now = rune(0);
  /** "loading" before the first read; "ready" after a read; "stale" when the last read failed and an older queue is shown; "refused" when the queue could not be read at all. */
  const status = rune<"idle" | "loading" | "ready" | "stale" | "refused">("idle");
  /** When the queue on screen was last read, in milliseconds. */
  const readAt = rune<number | null>(null);
  /** Requests a lecturer's action is in flight for. */
  const working = rune<string[]>([]);
  /** Why the lecturer's last action was not kept, or null. */
  const failure = rune<HelpDeskRefusal | null>(null);
  /** Requests the lecturer resolved here, offered as an explanation for everyone on their step (Rule 0407). */
  const offers = rune<HelpRequest[]>([]);
  /** Explanations broadcast on the course while the page is open, newest first (Rule 0405). */
  const explanations = rune<Annotation[]>([]);
  /** True when the last explanation was not kept. */
  const explainFailed = rune(false);
  /** Offers whose explanation is being posted: a second send waits for the first. */
  const explaining = rune<string[]>([]);

  let stops: Array<() => void> = [];
  let reads = 0;
  /** Changes heard (stream or the lecturer's own actions) since the read in flight started: reapplied over its answer. */
  let heardSinceRead: HelpRequest[] = [];
  /** The request the lecturer's last action closed, as it was kept. */
  let lastResolved: HelpRequest | null = null;

  const clockMs = () => adapters().clock.nowMs();

  /** Puts a changed request into the queue, or takes it out once it is no longer live. */
  function merge(changed: HelpRequest): void {
    if (changed.ref.courseId !== courseId.value) return;
    heardSinceRead.push(changed);
    apply(changed);
  }

  function apply(changed: HelpRequest): void {
    const others = requests.value.filter((r) => r.id !== changed.id);
    requests.value = isLive(changed) ? [...others, changed] : others;
  }

  async function refresh(): Promise<void> {
    const id = courseId.value;
    if (!id) return;
    const mine = ++reads;
    heardSinceRead = [];
    try {
      const read = await adapters().helpDesk.queue(id);
      if (mine !== reads || courseId.value !== id) return;
      // A read answers with the rows as they were when it ran: a change heard meanwhile is newer.
      const heard = heardSinceRead;
      heardSinceRead = [];
      requests.value = read;
      for (const changed of heard) apply(changed);
      readAt.value = clockMs();
      status.value = "ready";
    } catch {
      if (mine !== reads || courseId.value !== id) return;
      // The last queue stays on screen (Rule 0393); with none, there is nothing to show.
      status.value = readAt.value === null ? "refused" : "stale";
    }
  }

  async function act(id: string, run: () => Promise<HelpDeskResult>): Promise<boolean> {
    if (working.value.includes(id)) return false;
    working.value = [...working.value, id];
    try {
      const result = await run();
      if (!result.ok) {
        failure.value = result.reason;
        await refresh();
        return false;
      }
      failure.value = null;
      if (!isLive(result.request)) lastResolved = result.request;
      merge(result.request);
      return true;
    } finally {
      working.value = working.value.filter((w) => w !== id);
    }
  }

  /** An action that closes a request; once kept, the request is offered as an explanation for everyone on its step (Rule 0407). */
  async function closing(id: string, run: () => Promise<HelpDeskResult>): Promise<boolean> {
    lastResolved = null;
    const kept = await act(id, run);
    const request = kept ? (lastResolved as HelpRequest | null) : null;
    lastResolved = null;
    // The lecturer may have moved to another course's queue while the action was in flight.
    if (request && request.ref.courseId === courseId.value) offers.value = [...offers.value.filter((r) => r.id !== id), request];
    return kept;
  }

  /** A broadcast heard on the stream shows once; a revoked one leaves the list. */
  function hearExplanation(annotation: Annotation): void {
    if (annotation.anchor.ref.courseId !== courseId.value || !isBroadcast(annotation)) return;
    const others = explanations.value.filter((a) => a.id !== annotation.id);
    explanations.value = isRevoked(annotation) ? others : [annotation, ...others];
  }

  function stop(): void {
    for (const s of stops) s();
    stops = [];
    reads++;
    heardSinceRead = [];
  }

  return {
    courseId,
    requests,
    now,
    status,
    readAt,
    working,
    failure,

    /** Starts the queue of a course: reads it, hears its changes where streamed, ticks and reads again each minute. */
    async start(id: string): Promise<void> {
      stop();
      courseId.value = id;
      requests.value = [];
      readAt.value = null;
      failure.value = null;
      status.value = "loading";
      now.value = clockMs();
      offers.value = [];
      explanations.value = [];
      explainFailed.value = false;
      const unwatch: Unsubscribe = adapters().assistanceFeed.watch(id, (change) => {
        if (change.type === "help-request") merge(change.request);
        else hearExplanation(change.annotation);
      });
      const tick = setInterval(() => (now.value = clockMs()), TICK_MS);
      const reread = setInterval(() => void refresh(), QUEUE_REFRESH_MS);
      stops = [unwatch, () => clearInterval(tick), () => clearInterval(reread)];
      await refresh();
    },

    stop,
    refresh,

    /**
     * The queue now: live requests, lecturer requests first, then the longest waiting (Rules 0395,
     * 0396), each saying whether its student is online by `online`, which the page reads from
     * presence.
     */
    rows(online: (login: string) => boolean = () => false): QueueRow[] {
      const at = now.value;
      return requests.value
        .filter(isLive)
        .sort(queueOrder)
        .map((request) => ({
          request,
          waitingMs: waitingMs(request, at),
          escalation: shouldEscalate(request, at),
          online: online(request.learnerId),
          where: placeOf(request.ref)
        }));
    },

    /** The lecturer says they are on the way. */
    acknowledge(id: string): Promise<boolean> {
      return act(id, () => adapters().helpDesk.act(id, "acknowledge"));
    },

    /** The lecturer answers a Need-a-hint request with a hint they typed (Rule 0397); the hint can then be posted for everyone on the step. */
    answerHint(id: string, hintText: string): Promise<boolean> {
      if (!hintText.trim()) {
        failure.value = "hint-required";
        return Promise.resolve(false);
      }
      return closing(id, () => adapters().helpDesk.answerHint(id, hintText));
    },

    /** The lecturer resolves the request; once kept, it is offered as an explanation for everyone on its step (Rule 0407). */
    resolve(id: string): Promise<boolean> {
      return closing(id, () => adapters().helpDesk.act(id, "resolve"));
    },

    offers,
    explanations,
    explainFailed,
    explaining,

    /** The text an offer starts with: the lecturer's hint, when they typed one. */
    draftFor(request: HelpRequest): string {
      return request.hintText ?? "";
    },

    /** Posts the explanation for everyone on the offered request's step: a banner there and a toast elsewhere in the course. */
    async explain(id: string, body: string): Promise<boolean> {
      const request = offers.value.find((r) => r.id === id);
      if (!request || !body.trim() || explaining.value.includes(id)) return false;
      explaining.value = [...explaining.value, id];
      try {
        const result = await adapters().feedbackDesk.broadcast(request.ref, body, placeOf(request.ref).step);
        explainFailed.value = !result.ok;
        if (!result.ok) return false;
        offers.value = offers.value.filter((r) => r.id !== id);
        hearExplanation(result.annotation);
        return true;
      } finally {
        explaining.value = explaining.value.filter((e) => e !== id);
      }
    },

    /** The lecturer passes on explaining a resolved request. */
    skipExplain(id: string): void {
      offers.value = offers.value.filter((r) => r.id !== id);
    },

    /** Forgets the course: for tests and leaving the page. */
    reset(): void {
      stop();
      courseId.value = null;
      requests.value = [];
      status.value = "idle";
      readAt.value = null;
      working.value = [];
      failure.value = null;
      now.value = 0;
      offers.value = [];
      explanations.value = [];
      explainFailed.value = false;
      explaining.value = [];
    }
  };
}

export type HelpQueueService = ReturnType<typeof createHelpQueueService>;
export const helpQueueService = createHelpQueueService();
