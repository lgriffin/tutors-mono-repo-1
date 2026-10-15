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
 */
import { isLive, queueOrder, shouldEscalate, waitingMs, type Escalation, type HelpRequest } from "@tutors/domain/assistance";
import type { HelpDeskRefusal, HelpDeskResult, Unsubscribe } from "@tutors/application/ports";
import { adapters } from "../adapters.ts";
import { rune } from "../index.svelte.ts";

/** How often the queue is read from stored rows, stream or no stream. */
export const QUEUE_REFRESH_MS = 60_000;
const TICK_MS = 1_000;

/** One row of the queue as a lecturer sees it now. */
export type QueueRow = { request: HelpRequest; waitingMs: number; escalation: Escalation; online: boolean };

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

  let stops: Array<() => void> = [];
  let reads = 0;

  const clockMs = () => adapters().clock.nowMs();

  /** Puts a changed request into the queue, or takes it out once it is no longer live. */
  function merge(changed: HelpRequest): void {
    if (changed.ref.courseId !== courseId.value) return;
    const others = requests.value.filter((r) => r.id !== changed.id);
    requests.value = isLive(changed) ? [...others, changed] : others;
  }

  async function refresh(): Promise<void> {
    const id = courseId.value;
    if (!id) return;
    const mine = ++reads;
    try {
      const read = await adapters().helpDesk.queue(id);
      if (mine !== reads || courseId.value !== id) return;
      requests.value = read;
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
      merge(result.request);
      return true;
    } finally {
      working.value = working.value.filter((w) => w !== id);
    }
  }

  function stop(): void {
    for (const s of stops) s();
    stops = [];
    reads++;
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
      const unwatch: Unsubscribe = adapters().assistanceFeed.watch(id, (change) => {
        if (change.type === "help-request") merge(change.request);
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
        .map((request) => ({ request, waitingMs: waitingMs(request, at), escalation: shouldEscalate(request, at), online: online(request.learnerId) }));
    },

    /** The lecturer says they are on the way. */
    acknowledge(id: string): Promise<boolean> {
      return act(id, () => adapters().helpDesk.act(id, "acknowledge"));
    },

    /** The lecturer answers a Need-a-hint request with a hint they typed (Rule 0397). */
    answerHint(id: string, hintText: string): Promise<boolean> {
      if (!hintText.trim()) {
        failure.value = "hint-required";
        return Promise.resolve(false);
      }
      return act(id, () => adapters().helpDesk.answerHint(id, hintText));
    },

    /** The lecturer resolves the request. */
    resolve(id: string): Promise<boolean> {
      return act(id, () => adapters().helpDesk.act(id, "resolve"));
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
    }
  };
}

export type HelpQueueService = ReturnType<typeof createHelpQueueService>;
export const helpQueueService = createHelpQueueService();
