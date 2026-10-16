/**
 * In-memory adapters of the assistance, feedback, notes and insights ports: what the tests and the
 * anonymous reader compose until the real adapters arrive. Each keeps copies, so changing what it
 * returns never changes what it stores.
 */
import { isLive, type HelpRequest, type NewHelpRequest } from "@tutors/domain/assistance";
import { isFor, isRevoked, newestFirst, revokedAt, type Annotation, type NewAnnotation, type NewReflection, type Reflection } from "@tutors/domain/feedback";
import { sameStep, stepKey, type Note, type StepRef } from "@tutors/domain/learning";
import type { AssistanceChange, AssistanceFeed } from "../ports/assistance-feed.ts";
import type { AssistanceStore } from "../ports/assistance-store.ts";
import { RECEIVED_LIMIT, type FeedbackStore } from "../ports/feedback-store.ts";
import type { FeedbackDesk, FeedbackDeskResult, ReflectionDeskResult, StepFeedbackView } from "../ports/feedback-desk.ts";
import type { HelpDesk, HelpDeskResult } from "../ports/help-desk.ts";
import type { InsightsPeriod, InsightsRead } from "../ports/insights-read.ts";
import type { NotesStore } from "../ports/notes-store.ts";
import type { Unsubscribe } from "../ports/presence.ts";

const copy = <T>(value: T): T => structuredClone(value);

/** Help requests in memory. `unavailable` makes every call reject, as an unreachable store does. */
export class InMemoryAssistanceStore implements AssistanceStore {
  readonly rows: HelpRequest[] = [];
  unavailable = false;
  private nextId = 1;
  private check() {
    if (this.unavailable) throw new Error("assistance store unavailable");
  }
  async open(request: NewHelpRequest): Promise<HelpRequest> {
    this.check();
    if (!request.ref?.courseId || !request.learnerId) throw new Error("a help request needs a step and a learner");
    if (this.rows.some((r) => r.ref.courseId === request.ref.courseId && r.learnerId === request.learnerId && isLive(r))) {
      throw new Error("the learner already has a live help request in the course");
    }
    const row: HelpRequest = { ...copy(request), id: `help-${this.nextId++}` };
    this.rows.push(row);
    return copy(row);
  }
  async get(id: string): Promise<HelpRequest | null> {
    this.check();
    const row = this.rows.find((r) => r.id === id);
    return row ? copy(row) : null;
  }
  async live(courseId: string): Promise<HelpRequest[]> {
    this.check();
    return this.rows.filter((r) => r.ref.courseId === courseId && isLive(r)).map(copy);
  }
  async latest(courseId: string, learnerId: string): Promise<HelpRequest | null> {
    this.check();
    const mine = this.rows.filter((r) => r.ref.courseId === courseId && r.learnerId === learnerId);
    const last = mine.reduce<HelpRequest | null>((a, r) => (!a || Date.parse(r.requestedAt) >= Date.parse(a.requestedAt) ? r : a), null);
    return last ? copy(last) : null;
  }
  async replace(next: HelpRequest, prior: HelpRequest): Promise<boolean> {
    this.check();
    const index = this.rows.findIndex((r) => r.id === next.id);
    const stored = this.rows[index];
    if (index < 0 || stored.state !== prior.state || stored.kind !== prior.kind || !sameStep(stored.ref, prior.ref) || stored.helped !== prior.helped) return false;
    this.rows[index] = copy(next);
    return true;
  }
}

/** Delivers assistance changes to watchers in the same process, and keeps what was published. */
export class InMemoryAssistanceFeed implements AssistanceFeed {
  readonly published: AssistanceChange[] = [];
  private readonly listeners = new Map<string, Set<(change: AssistanceChange) => void>>();
  /** When false, publishing is refused: a deployment with no feed. */
  constructor(private readonly configured = true) {}
  async publish(change: AssistanceChange): Promise<boolean> {
    if (!this.configured || !change.courseId) return false;
    this.published.push(copy(change));
    for (const listener of this.listeners.get(change.courseId) ?? []) listener(copy(change));
    return true;
  }
  watch(courseId: string, listener: (change: AssistanceChange) => void): Unsubscribe {
    const set = this.listeners.get(courseId) ?? new Set();
    set.add(listener);
    this.listeners.set(courseId, set);
    return () => void set.delete(listener);
  }
}

/** Annotations and reflections in memory. `unavailable` makes every call reject, as an unreachable store does. */
export class InMemoryFeedbackStore implements FeedbackStore {
  readonly annotations: Annotation[] = [];
  readonly reflectionRows: Reflection[] = [];
  unavailable = false;
  private nextId = 1;
  private check() {
    if (this.unavailable) throw new Error("feedback store unavailable");
  }
  async annotate(annotation: NewAnnotation): Promise<Annotation> {
    this.check();
    if (!annotation.anchor?.ref?.courseId || !annotation.authorId || !annotation.body) throw new Error("an annotation needs a step, an author and a body");
    const row: Annotation = { ...copy(annotation), id: `annotation-${this.nextId++}`, revokedAt: null };
    this.annotations.push(row);
    return copy(row);
  }
  async get(id: string): Promise<Annotation | null> {
    this.check();
    const row = this.annotations.find((a) => a.id === id);
    return row ? copy(row) : null;
  }
  async forStep(ref: StepRef): Promise<Annotation[]> {
    this.check();
    return this.annotations.filter((a) => stepKey(a.anchor.ref) === stepKey(ref)).map(copy);
  }
  async received(courseId: string, learnerId: string): Promise<Annotation[]> {
    this.check();
    return newestFirst(this.annotations.filter((a) => a.anchor.ref.courseId === courseId && !isRevoked(a) && isFor(a, learnerId)))
      .slice(0, RECEIVED_LIMIT)
      .map(copy);
  }
  async revoke(id: string, at: string): Promise<Annotation | null> {
    this.check();
    const index = this.annotations.findIndex((a) => a.id === id);
    if (index < 0) return null;
    this.annotations[index] = revokedAt(this.annotations[index], at);
    return copy(this.annotations[index]);
  }
  async reflect(reflection: NewReflection): Promise<Reflection> {
    this.check();
    if (!reflection.ref?.courseId || !reflection.learnerId || !reflection.body) throw new Error("a reflection needs a step, a learner and a body");
    const row: Reflection = { ...copy(reflection), id: `reflection-${this.nextId++}` };
    this.reflectionRows.push(row);
    return copy(row);
  }
  async reflections(courseId: string, learnerId: string): Promise<Reflection[]> {
    this.check();
    return this.reflectionRows.filter((r) => r.ref.courseId === courseId && r.learnerId === learnerId).map(copy);
  }
  async reflectionsAt(ref: StepRef): Promise<Reflection[]> {
    this.check();
    return this.reflectionRows.filter((r) => sameStep(r.ref, ref)).map(copy);
  }
}

/**
 * Private notes in memory, keyed by step. `failing` makes reads and writes reject, as browser
 * storage that is unavailable or full does.
 */
export class InMemoryNotesStore implements NotesStore {
  readonly notes = new Map<string, Note>();
  failing = false;
  private check() {
    if (this.failing) throw new Error("storage unavailable");
  }
  async get(ref: StepRef): Promise<Note | null> {
    this.check();
    const note = this.notes.get(stepKey(ref));
    return note ? copy(note) : null;
  }
  async put(note: Note): Promise<void> {
    this.check();
    this.notes.set(stepKey(note.ref), copy(note));
  }
  async remove(ref: StepRef): Promise<void> {
    this.check();
    this.notes.delete(stepKey(ref));
  }
  async forCourse(courseId: string): Promise<Note[]> {
    this.check();
    return [...this.notes.values()].filter((n) => n.ref.courseId === courseId).map(copy);
  }
}

const within = (iso: string, period: InsightsPeriod) => iso >= period.from && iso < period.to;

/** Answers insights from the rows it was given, and counts the reads it served. */
export class InMemoryInsightsRead implements InsightsRead {
  reads = 0;
  constructor(
    private readonly requests: readonly HelpRequest[] = [],
    private readonly annotationRows: readonly Annotation[] = [],
    private readonly reflectionRows: readonly Reflection[] = []
  ) {}
  async helpRequests(courseId: string, period: InsightsPeriod): Promise<HelpRequest[]> {
    this.reads++;
    return this.requests.filter((r) => r.ref.courseId === courseId && within(r.requestedAt, period)).map(copy);
  }
  async annotations(courseId: string, period: InsightsPeriod): Promise<Annotation[]> {
    this.reads++;
    return this.annotationRows.filter((a) => a.anchor.ref.courseId === courseId && within(a.createdAt, period)).map(copy);
  }
  async reflections(courseId: string, period: InsightsPeriod): Promise<Reflection[]> {
    this.reads++;
    return this.reflectionRows.filter((r) => r.ref.courseId === courseId && within(r.sharedAt, period)).map(copy);
  }
}

/** A help desk for a deployment where nobody can sign in: every ask is refused and there is nothing to read. */
export class SignedOutHelpDesk implements HelpDesk {
  async ask(): Promise<HelpDeskResult> {
    return { ok: false, reason: "signed-out" };
  }
  async act(): Promise<HelpDeskResult> {
    return { ok: false, reason: "signed-out" };
  }
  async answerHint(): Promise<HelpDeskResult> {
    return { ok: false, reason: "signed-out" };
  }
  async rate(): Promise<HelpDeskResult> {
    return { ok: false, reason: "signed-out" };
  }
  async mine(): Promise<HelpRequest | null> {
    return null;
  }
  async queue(): Promise<HelpRequest[]> {
    throw new Error("nobody is signed in to read a help queue");
  }
}

/** A feedback desk for a deployment where nobody can sign in: nothing to read, and every ask is refused. */
export class SignedOutFeedbackDesk implements FeedbackDesk {
  async step(): Promise<StepFeedbackView> {
    return { broadcasts: [], personal: [], history: null };
  }
  async received(): Promise<Annotation[]> {
    return [];
  }
  async annotate(): Promise<FeedbackDeskResult> {
    return { ok: false, reason: "signed-out" };
  }
  async broadcast(): Promise<FeedbackDeskResult> {
    return { ok: false, reason: "signed-out" };
  }
  async revoke(): Promise<FeedbackDeskResult> {
    return { ok: false, reason: "signed-out" };
  }
  async reflect(): Promise<ReflectionDeskResult> {
    return { ok: false, reason: "signed-out" };
  }
}
