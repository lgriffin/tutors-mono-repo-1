/**
 * Lecturer feedback on a lab step, in the reader: a signed-in student sees the explanations broadcast
 * to everyone on the step above its content and the annotations addressed to them below it, from one
 * read (Rule 0403), read again every FEEDBACK_POLL_MS while the step stays on screen and visible,
 * without joining any realtime channel (Rule 0404). An educator of the course also gets the step's
 * history and the reflections shared there, posts, broadcasts and revokes. A student shares a note
 * as a reflection and reads what they received in the course, newest first (Rule 0409).
 *
 * Everything goes through the FeedbackDesk the app composed (the reader's /api/feedback); bodies are
 * markdown, rendered by the app's content renderer and sanitised by the caller, as lab content is
 * (Rule 0408). Hidden in anonymous mode and for visitors.
 */
import { sameStep, type Note, type StepRef } from "@tutors/domain/learning";
import type { Annotation, Reflection } from "@tutors/domain/feedback";
import type { FeedbackDeskRefusal, FeedbackDeskResult, StepFeedbackView } from "@tutors/application/ports";
import { adapters } from "../adapters.ts";
import { rune } from "../index.svelte.ts";

/** How often the step's feedback is read again while it stays on screen (Rule 0404). */
export const FEEDBACK_POLL_MS = 60_000;

const EMPTY: StepFeedbackView = { broadcasts: [], personal: [], history: null };

function createFeedbackService() {
  /** True when feedback is offered: someone is signed in and the reader is not anonymous. */
  const available = rune(false);
  /** The step on screen, or null away from a lab. */
  const step = rune<StepRef | null>(null);
  /** The step's feedback as the reader last answered it. */
  const view = rune<StepFeedbackView>(EMPTY);
  /** Broadcasts the student closed in this session; they stay in the Notes panel's history. */
  const dismissed = rune<string[]>([]);
  /** What the student received in the course, newest first, once read. */
  const received = rune<Annotation[] | null>(null);
  const sending = rune(false);
  /** Why the last post was not kept, or null. */
  const failure = rune<FeedbackDeskRefusal | null>(null);

  let poll: ReturnType<typeof setInterval> | null = null;
  let reads = 0;
  /** Who the feedback on screen was read for: another sign-in forgets it before anything is read. */
  let reader: string | null = null;
  /** Bumped when the received list is forgotten, so an older read cannot bring it back. */
  let receivedReads = 0;
  /** The course the received list was read for. */
  let receivedFor: string | null = null;

  const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";

  function stopPolling(): void {
    if (poll) clearInterval(poll);
    poll = null;
  }

  /** Reads the step's feedback again; a failed read keeps what is on screen. */
  async function refresh(): Promise<void> {
    const ref = step.value;
    if (!ref || !available.value) return;
    const mine = ++reads;
    try {
      const read = await adapters().feedbackDesk.step(ref);
      if (mine === reads && step.value && sameStep(step.value, ref)) view.value = read;
    } catch {
      // What is on screen stays until a read answers.
    }
  }

  /** An educator's post: kept, the step is read again so every view shows it; refused, the reason is kept. */
  async function post(run: () => Promise<FeedbackDeskResult>): Promise<boolean> {
    if (sending.value) return false;
    sending.value = true;
    try {
      const result = await run();
      failure.value = result.ok ? null : result.reason;
      if (result.ok) await refresh();
      return result.ok;
    } finally {
      sending.value = false;
    }
  }

  return {
    available,
    step,
    view,
    dismissed,
    received,
    sending,
    failure,

    /**
     * The student arrived at a lab step: signed in, its feedback is read at once and every minute
     * while visible. Signing out, or in as someone else, forgets what was read for the last person.
     */
    async arrive(ref: StepRef, login: string | null): Promise<void> {
      const moved = !step.value || !sameStep(step.value, ref);
      step.value = ref;
      available.value = !!login && !adapters().anonymous;
      if (login !== reader) {
        reader = login;
        reads++;
        receivedReads++;
        view.value = EMPTY;
        dismissed.value = [];
        received.value = null;
        receivedFor = null;
      }
      if (!available.value) {
        stopPolling();
        view.value = EMPTY;
        return;
      }
      if (moved) {
        view.value = EMPTY;
        failure.value = null;
      }
      if (!poll) poll = setInterval(() => visible() && void refresh(), FEEDBACK_POLL_MS);
      await refresh();
    },

    refresh,

    /** The broadcasts on the step the student has not closed in this session. */
    banners(): Annotation[] {
      return view.value.broadcasts.filter((a) => !dismissed.value.includes(a.id));
    },

    /** The student closes a broadcast for this session. */
    dismiss(id: string): void {
      if (!dismissed.value.includes(id)) dismissed.value = [...dismissed.value, id];
    },

    /** An educator explains something to everyone on the step: a banner there and a toast elsewhere in the course. */
    broadcast(body: string, stepTitle?: string): Promise<boolean> {
      const ref = step.value;
      return ref ? post(() => adapters().feedbackDesk.broadcast(ref, body, stepTitle)) : Promise.resolve(false);
    },

    /** An educator writes to one student about the step. */
    annotate(learnerId: string, body: string): Promise<boolean> {
      const ref = step.value;
      return ref ? post(() => adapters().feedbackDesk.annotate({ ref }, { learnerId }, body)) : Promise.resolve(false);
    },

    /** An educator replies to a reflection shared on the step: to the student who shared it. */
    reply(reflection: Reflection, body: string): Promise<boolean> {
      return post(() => adapters().feedbackDesk.annotate({ ref: reflection.ref, reflectionId: reflection.id }, { learnerId: reflection.learnerId }, body));
    },

    /** An educator revokes an annotation: students stop seeing it on their next read (Rule 0406). */
    revoke(id: string): Promise<boolean> {
      return post(() => adapters().feedbackDesk.revoke(id));
    },

    /** The student shares a step's note with the course's educators as a reflection; the note stays theirs (Rule 0384). */
    async share(note: Note): Promise<boolean> {
      if (!available.value || sending.value) return false;
      sending.value = true;
      try {
        const result = await adapters().feedbackDesk.reflect(note);
        failure.value = result.ok ? null : result.reason;
        return result.ok;
      } finally {
        sending.value = false;
      }
    },

    /** Reads what the student received in the course, newest first (Rule 0409); a failed read keeps the last one. */
    async readReceived(courseId: string): Promise<void> {
      if (!available.value || !courseId) return;
      if (receivedFor !== courseId) {
        received.value = null;
        receivedFor = courseId;
      }
      const mine = ++receivedReads;
      try {
        const read = await adapters().feedbackDesk.received(courseId);
        if (mine === receivedReads && receivedFor === courseId) received.value = read;
      } catch {
        // The last history read stays.
      }
    },

    /** A body as the reader renders markdown; the caller sanitises it, as lab content is (Rule 0408). */
    render(markdown: string): string {
      return adapters().renderer.renderMarkdown(markdown);
    },

    /** Leaves the lab: stops reading. */
    leave(): void {
      stopPolling();
      reads++;
      step.value = null;
    },

    /** Forgets everything: for tests and sign-out. */
    reset(): void {
      stopPolling();
      reads++;
      receivedReads++;
      reader = null;
      receivedFor = null;
      available.value = false;
      step.value = null;
      view.value = EMPTY;
      dismissed.value = [];
      received.value = null;
      sending.value = false;
      failure.value = null;
    }
  };
}

export type FeedbackService = ReturnType<typeof createFeedbackService>;
export const feedbackService = createFeedbackService();
