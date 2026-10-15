/**
 * In-memory adapters of the assistance, feedback, notes and insights ports: what the tests and the
 * anonymous reader compose until the real adapters arrive. Each keeps copies, so changing what it
 * returns never changes what it stores.
 */
import { isLive, type HelpRequest, type NewHelpRequest } from "@tutors/domain/assistance";
import type { Annotation, NewAnnotation, NewReflection, Reflection } from "@tutors/domain/feedback";
import { sameStep, stepKey, type Note, type StepRef } from "@tutors/domain/learning";
import type { AssistanceChange, AssistanceFeed } from "../ports/assistance-feed.ts";
import type { AssistanceStore } from "../ports/assistance-store.ts";
import type { FeedbackStore } from "../ports/feedback-store.ts";
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
  async replace(next: HelpRequest, prior: HelpRequest): Promise<boolean> {
    this.check();
    const index = this.rows.findIndex((r) => r.id === next.id);
    const stored = this.rows[index];
    if (index < 0 || stored.state !== prior.state || stored.kind !== prior.kind || !sameStep(stored.ref, prior.ref)) return false;
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

/** Annotations and reflections in memory. */
export class InMemoryFeedbackStore implements FeedbackStore {
  readonly annotations: Annotation[] = [];
  readonly reflectionRows: Reflection[] = [];
  private nextId = 1;
  async annotate(annotation: NewAnnotation): Promise<Annotation> {
    if (!annotation.anchor?.ref?.courseId || !annotation.authorId || !annotation.body) throw new Error("an annotation needs a step, an author and a body");
    const row: Annotation = { ...copy(annotation), id: `annotation-${this.nextId++}`, revokedAt: null };
    this.annotations.push(row);
    return copy(row);
  }
  async forStep(ref: StepRef): Promise<Annotation[]> {
    return this.annotations.filter((a) => stepKey(a.anchor.ref) === stepKey(ref)).map(copy);
  }
  async reflect(reflection: NewReflection): Promise<Reflection> {
    if (!reflection.ref?.courseId || !reflection.learnerId || !reflection.body) throw new Error("a reflection needs a step, a learner and a body");
    const row: Reflection = { ...copy(reflection), id: `reflection-${this.nextId++}` };
    this.reflectionRows.push(row);
    return copy(row);
  }
  async reflections(courseId: string, learnerId: string): Promise<Reflection[]> {
    return this.reflectionRows.filter((r) => r.ref.courseId === courseId && r.learnerId === learnerId).map(copy);
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
