/**
 * In-memory adapters for every port: what tests and the anonymous reader run against. Each one
 * keeps its state in plain collections and behaves as the contract suites say a real adapter must.
 */
import type { Course, Lo } from "@tutors/domain/course";
import type { ContentLock } from "@tutors/domain/access";
import type { LearningEvent, CalendarEntry, LearningRecord, TutorsConnectUser } from "@tutors/domain/learning";
import type { CourseVisit, PresenceEvent, Sentiment, StoredPresence } from "@tutors/domain/presence";
import { CourseNotFoundError, type CourseLocation, type CourseSource } from "../ports/course-source.ts";
import type { CourseEmitter } from "../ports/course-emitter.ts";
import type { ContentRenderer } from "../ports/content-renderer.ts";
import type { LearningEventSink } from "../ports/learning-event-sink.ts";
import type { LearningRecords } from "../ports/learning-records.ts";
import type { PresencePort, Unsubscribe } from "../ports/presence.ts";
import type { LearnerProfile, ProfilePort } from "../ports/profile.ts";
import type { IdentityClient, SessionPort } from "../ports/session.ts";
import type { AccessStore } from "../ports/access-store.ts";
import type { AppEvent, EventPublisher } from "../ports/event-publisher.ts";
import type { Clock } from "../ports/clock.ts";
import type { AssignmentSource, MoodleAssignSubmissionsResponse, MoodleCourseSection } from "../ports/assignment-source.ts";
import type { CodeRuntime, CodeRuntimeOptions, CodeRuntimePort, ExecuteRequest, ExecutionResult, RuntimeEvent, RuntimeId } from "../ports/code-runtime.ts";
import type { WorkspaceStore } from "../ports/workspace-store.ts";
import type { ScormRecord, ScormRecords } from "../ports/scorm-records.ts";
import { SNAPSHOT_OUTPUT_LIMIT, type PlaygroundSnapshot, type PlaygroundSnapshots } from "../ports/playground-snapshots.ts";
import type { PlaygroundLive, PlaygroundLiveState, PlaygroundShare } from "../ports/playground-live.ts";
import type { Workspace } from "@tutors/domain/course/playground";
import type { Actor } from "@tutors/domain/access";
import type { NewSnippet, SharedSnippet, SnippetStore } from "../ports/snippet-store.ts";
import type { CourseNotice, CourseNoticeType, CourseNotices } from "../ports/course-notices.ts";

/** A clock stopped at one instant; `advance` moves it. */
export class FixedClock implements Clock {
  constructor(private at: number = Date.parse("2026-01-05T09:00:00.000Z")) {}
  now(): Date {
    return new Date(this.at);
  }
  nowMs(): number {
    return this.at;
  }
  advance(ms: number): void {
    this.at += ms;
  }
  set(iso: string): void {
    this.at = Date.parse(iso);
  }
}

/** Serves the tutors.json texts it was given, keyed by course id. */
export class InMemoryCourseSource implements CourseSource {
  readonly loads: CourseLocation[] = [];
  constructor(private readonly courses: Record<string, string | object> = {}) {}
  add(courseId: string, course: string | object): void {
    this.courses[courseId] = course;
  }
  async load(location: CourseLocation): Promise<string> {
    this.loads.push(location);
    const course = this.courses[location.courseId];
    if (course === undefined) throw new CourseNotFoundError(location.courseId, location.courseUrl);
    return typeof course === "string" ? course : JSON.stringify(course);
  }
}

/** Remembers what was emitted where. */
export class InMemoryCourseEmitter implements CourseEmitter {
  readonly emitted: Array<{ course: Course; destination: string }> = [];
  async emit(course: Course, destination: string): Promise<void> {
    this.emitted.push({ course, destination });
  }
}

/** Wraps markdown in a paragraph: enough to see that rendering happened and where. */
export class PassThroughRenderer implements ContentRenderer {
  mathLoads = 0;
  renderLo(_course: Course, lo: Lo): void {
    if (lo.contentMd) lo.contentHtml = this.renderMarkdown(lo.contentMd);
    this.renderSummary(lo);
  }
  renderSummary(lo: Lo): void {
    if (lo.summary) lo.summary = this.renderMarkdown(lo.summary);
  }
  renderMarkdown(md: string): string {
    return `<p>${md}</p>`;
  }
  mayContainMath(text: string): boolean {
    return text.includes("$");
  }
  async loadMath(): Promise<void> {
    this.mathLoads++;
  }
}

/** Keeps every learning event it is given, in order. */
export class InMemoryLearningEventSink implements LearningEventSink {
  readonly recorded: Array<{ event: LearningEvent; learnerId: string }> = [];
  async record(event: LearningEvent, learnerId: string): Promise<void> {
    this.recorded.push({ event, learnerId });
  }
}

/** Answers from the rows it was given. */
export class InMemoryLearningRecords implements LearningRecords {
  constructor(
    private readonly calendar: CalendarEntry[] = [],
    private readonly records: LearningRecord[] = [],
    private readonly users: TutorsConnectUser[] = []
  ) {}
  async calendarEntries(courseId: string, start?: string | null, end?: string | null): Promise<CalendarEntry[]> {
    return this.calendar.filter((e) => e.courseid === courseId && (!start || e.id >= start) && (!end || e.id <= end));
  }
  async learningRecords(courseId: string, learnerId?: string): Promise<LearningRecord[]> {
    return this.records.filter((r) => r.course_id === courseId && (!learnerId || r.student_id === learnerId));
  }
  async learners(courseId: string): Promise<TutorsConnectUser[]> {
    const ids = new Set(this.records.filter((r) => r.course_id === courseId).map((r) => r.student_id));
    return this.users.filter((u) => ids.has(u.github_id));
  }
}

/** Delivers presence events to subscribers in the same process and keeps the latest snapshot per learner per course. */
export class InMemoryPresence implements PresencePort {
  readonly published: PresenceEvent[] = [];
  private readonly latest = new Map<string, { event: PresenceEvent; receivedAt: string }>();
  private readonly listeners = new Set<{ listener: (event: PresenceEvent) => void; courseId?: string }>();
  constructor(private readonly clock: Clock = new FixedClock()) {}
  async publish(event: PresenceEvent): Promise<void> {
    this.published.push(event);
    const id = event.user?.id;
    if (id) this.latest.set(`${event.courseId}\t${id}`, { event, receivedAt: this.clock.now().toISOString() });
    for (const { listener, courseId } of this.listeners) {
      if (!courseId || courseId === event.courseId) listener(event);
    }
  }
  subscribe(listener: (event: PresenceEvent) => void, courseId?: string): Unsubscribe {
    const entry = { listener, courseId };
    this.listeners.add(entry);
    return () => this.listeners.delete(entry);
  }
  async recent(courseId: string, sinceIso: string): Promise<StoredPresence[] | null> {
    return [...this.latest.entries()]
      .filter(([key, { receivedAt }]) => key.startsWith(`${courseId}\t`) && receivedAt >= sinceIso)
      .sort((a, b) => (a[1].receivedAt < b[1].receivedAt ? 1 : -1))
      .map(([, { event }]) => ({ payload: event }));
  }
}

/** One learner record per login, in memory. */
export class InMemoryProfile implements ProfilePort {
  readonly visits = new Map<string, CourseVisit[]>();
  readonly learners = new Map<string, LearnerProfile>();
  readonly sentiments = new Map<string, Sentiment>();
  readonly sharing = new Map<string, boolean>();
  async getCourseVisits(learnerId: string): Promise<CourseVisit[]> {
    return structuredClone(this.visits.get(learnerId) ?? []);
  }
  async saveCourseVisits(learnerId: string, visits: CourseVisit[]): Promise<void> {
    this.visits.set(learnerId, structuredClone(visits));
  }
  async upsertLearner(profile: LearnerProfile): Promise<void> {
    this.learners.set(profile.login, { ...profile });
    if (profile.sharing !== null) this.sharing.set(profile.login, profile.sharing);
  }
  async getSentiment(learnerId: string): Promise<Sentiment | null> {
    return this.sentiments.get(learnerId) ?? null;
  }
  async setSentiment(learnerId: string, sentiment: Sentiment): Promise<void> {
    this.sentiments.set(learnerId, sentiment);
  }
  async getSharing(learnerId: string): Promise<boolean | null> {
    return this.sharing.get(learnerId) ?? null;
  }
  async setSharing(learnerId: string, sharing: boolean): Promise<void> {
    this.sharing.set(learnerId, sharing);
  }
}

/** A session for one fixed actor, or for nobody. */
export class FixedSession implements SessionPort {
  constructor(private readonly actor: Actor | null = null) {}
  async getActor(): Promise<Actor | null> {
    return this.actor;
  }
}

/** Remembers the sign-ins and sign-outs asked for. */
export class RecordingIdentityClient implements IdentityClient {
  readonly signIns: string[] = [];
  readonly signOuts: string[] = [];
  async signIn(returnTo: string): Promise<void> {
    this.signIns.push(returnTo);
  }
  async signOut(returnTo: string): Promise<void> {
    this.signOuts.push(returnTo);
  }
}

/** Content locks per course, in memory. */
export class InMemoryAccessStore implements AccessStore {
  private readonly rows = new Map<string, ContentLock>();
  constructor(private readonly clock: Clock = new FixedClock()) {}
  async locks(courseId: string): Promise<ContentLock[]> {
    return [...this.rows.values()].filter((lock) => lock.course_id === courseId).map((lock) => ({ ...lock }));
  }
  async setLock(courseId: string, loRoute: string, locked: boolean, lockedBy: string): Promise<boolean> {
    if (!courseId || !loRoute || !lockedBy) return false;
    this.rows.set(`${courseId}\t${loRoute}`, { course_id: courseId, lo_route: loRoute, locked, locked_by: lockedBy, locked_at: this.clock.now().toISOString() });
    return true;
  }
  async removeLock(courseId: string, loRoute: string): Promise<boolean> {
    if (!courseId || !loRoute) return false;
    return this.rows.delete(`${courseId}\t${loRoute}`);
  }
}

/** Delivers application events to subscribers in the same process, and keeps them for assertions. */
export class RecordingPublisher implements EventPublisher {
  readonly events: AppEvent[] = [];
  private readonly listeners = new Set<(event: AppEvent) => void>();
  async publish(event: AppEvent): Promise<void> {
    this.events.push(event);
    for (const listener of this.listeners) listener(event);
  }
  subscribe(listener: (event: AppEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** Answers from the sections and submissions it was given. */
export class InMemoryAssignmentSource implements AssignmentSource {
  constructor(
    private readonly sections: Record<number, MoodleCourseSection[]> = {},
    private readonly submissions: MoodleAssignSubmissionsResponse = { assignments: [] }
  ) {}
  async courseContents(courseId: number): Promise<MoodleCourseSection[]> {
    return this.sections[courseId] ?? [];
  }
  async assignmentSubmissions(assignmentIds: number[]): Promise<MoodleAssignSubmissionsResponse> {
    return { assignments: this.submissions.assignments.filter((a) => assignmentIds.includes(a.assignmentid)) };
  }
}

/** Keeps workspaces in a map: what a shared link opens with (nothing is kept beyond the page), and what tests use. */
export class InMemoryWorkspaceStore implements WorkspaceStore {
  private readonly store = new Map<string, Workspace>();
  private key(courseId: string, loId: string): string {
    return `${courseId}::${loId}`;
  }
  async load(courseId: string, loId: string): Promise<Workspace | null> {
    return this.store.get(this.key(courseId, loId)) ?? null;
  }
  async save(workspace: Workspace): Promise<void> {
    this.store.set(this.key(workspace.courseId, workspace.loId), workspace);
  }
  async remove(courseId: string, loId: string): Promise<void> {
    this.store.delete(this.key(courseId, loId));
  }
}

/** Keeps each learner's SCORM state per course and learning object. */
export class InMemoryScormRecords implements ScormRecords {
  readonly records = new Map<string, ScormRecord>();
  private key(courseId: string, learnerId: string, loId: string): string {
    return `${courseId}::${learnerId}::${loId}`;
  }
  async load(courseId: string, learnerId: string, loId: string): Promise<Record<string, string>> {
    if (!courseId || !learnerId || !loId) return {};
    return { ...(this.records.get(this.key(courseId, learnerId, loId))?.cmi ?? {}) };
  }
  async save(record: ScormRecord): Promise<void> {
    if (!record.courseId || !record.learnerId || !record.loId) return;
    this.records.set(this.key(record.courseId, record.learnerId, record.loId), { ...record, cmi: { ...record.cmi } });
  }
}

export type InMemoryPlaygroundSnapshotsOptions = {
  /** Whether handing in is offered at all; the anonymous reader says no. */
  enabled?: boolean;
  /** The courses the signed-in user reviews, by course id. */
  reviews?: string[];
};

/** Keeps snapshots in memory, newest first, with the reviewer decided by its options rather than by the page. */
export class InMemoryPlaygroundSnapshots implements PlaygroundSnapshots {
  readonly rows: PlaygroundSnapshot[] = [];
  private readonly enabled: boolean;
  private readonly reviewer: Set<string>;
  constructor(options: InMemoryPlaygroundSnapshotsOptions = {}, private readonly now: () => Date = () => new Date()) {
    this.enabled = options.enabled ?? true;
    this.reviewer = new Set(options.reviews ?? []);
  }
  async available(): Promise<boolean> {
    return this.enabled;
  }
  async reviews(courseId: string): Promise<boolean> {
    return this.enabled && this.reviewer.has(courseId);
  }
  async save(snapshot: Omit<PlaygroundSnapshot, "updatedAt">): Promise<boolean> {
    if (!this.enabled) return false;
    if (!snapshot.courseId || !snapshot.loId || !snapshot.studentId) return false;
    await this.remove(snapshot.courseId, snapshot.loId, snapshot.studentId);
    this.rows.unshift({ ...snapshot, files: snapshot.files.map((file) => ({ ...file })), lastOutput: snapshot.lastOutput.slice(0, SNAPSHOT_OUTPUT_LIMIT), updatedAt: this.now().toISOString() });
    return true;
  }
  async get(courseId: string, loId: string, studentId: string): Promise<PlaygroundSnapshot | null> {
    if (!this.enabled) return null;
    return this.rows.find((row) => row.courseId === courseId && row.loId === loId && row.studentId === studentId) ?? null;
  }
  async list(courseId: string, loId: string): Promise<PlaygroundSnapshot[]> {
    if (!this.enabled) return [];
    return this.rows.filter((row) => row.courseId === courseId && row.loId === loId);
  }
  async remove(courseId: string, loId: string, studentId: string): Promise<void> {
    const index = this.rows.findIndex((row) => row.courseId === courseId && row.loId === loId && row.studentId === studentId);
    if (index >= 0) this.rows.splice(index, 1);
  }
}

/** A live-attach bus in one process: sharers and watchers of the same exercise hear each other. */
export class InMemoryPlaygroundLive implements PlaygroundLive {
  private readonly watchers = new Map<string, Set<(state: PlaygroundLiveState) => void>>();
  private readonly sharers = new Map<string, Set<() => void>>();
  /** Every state a sharer sent, oldest first. */
  readonly sent: PlaygroundLiveState[] = [];
  private key(courseId: string, loId: string): string {
    return `${courseId}::${loId}`;
  }
  share(courseId: string, loId: string, onWatcher: () => void): PlaygroundShare {
    const key = this.key(courseId, loId);
    const listeners = this.sharers.get(key) ?? new Set();
    listeners.add(onWatcher);
    this.sharers.set(key, listeners);
    let active = true;
    return {
      send: (state) => {
        if (!active) return;
        this.sent.push(state);
        for (const watcher of this.watchers.get(key) ?? []) watcher(state);
      },
      stop: () => {
        active = false;
        listeners.delete(onWatcher);
      }
    };
  }
  watch(courseId: string, loId: string, onState: (state: PlaygroundLiveState) => void): () => void {
    const key = this.key(courseId, loId);
    const listeners = this.watchers.get(key) ?? new Set();
    listeners.add(onState);
    this.watchers.set(key, listeners);
    for (const sharer of this.sharers.get(key) ?? []) sharer();
    return () => listeners.delete(onState);
  }
}

/** What a scripted run-time answers an execute request with. */
export type ScriptedExecution = { ok?: boolean; stdout?: string; stderr?: string; value?: string; error?: string };

/**
 * A run-time that answers from a script instead of running anything: each execute request takes
 * the next scripted answer (or an empty success), emitting the same events a sandbox would.
 */
export class ScriptedCodeRuntime implements CodeRuntime {
  readonly runtime: RuntimeId;
  readonly requests: ExecuteRequest[] = [];
  readonly answers: ScriptedExecution[] = [];
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private started = false;
  private disposed = false;
  private restarts = 0;
  private sequence = 0;
  constructor(options: CodeRuntimeOptions) {
    this.runtime = options.runtime;
    if (options.onEvent) this.listeners.add(options.onEvent);
  }
  /** Queue what the next executions answer with. */
  script(...answers: ScriptedExecution[]): this {
    this.answers.push(...answers);
    return this;
  }
  get restartCount(): number {
    return this.restarts;
  }
  get isStarted(): boolean {
    return this.started;
  }
  get isDisposed(): boolean {
    return this.disposed;
  }
  private emit(event: RuntimeEvent): void {
    this.listeners.forEach((listener) => listener(event));
  }
  subscribe(onEvent: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(onEvent);
    return () => this.listeners.delete(onEvent);
  }
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.emit({ type: "ready" });
  }
  async execute(request: Omit<ExecuteRequest, "id"> & { id?: string }): Promise<ExecutionResult> {
    if (this.disposed) throw new Error("This run-time has been disposed");
    await this.start();
    const id = request.id ?? `exec-${++this.sequence}`;
    this.requests.push({ ...request, id });
    const answer = this.answers.shift() ?? {};
    const chunks: string[] = [];
    this.emit({ type: "status", id, phase: "running" });
    if (answer.stdout) {
      chunks.push(answer.stdout);
      this.emit({ type: "stream", id, stream: "stdout", text: answer.stdout });
    }
    if (answer.stderr) {
      chunks.push(answer.stderr);
      this.emit({ type: "stream", id, stream: "stderr", text: answer.stderr });
    }
    if (answer.value) this.emit({ type: "result", id, value: answer.value });
    if (answer.error) {
      chunks.push(answer.error.endsWith("\n") ? answer.error : `${answer.error}\n`);
      this.emit({ type: "error", id, message: answer.error });
    }
    const ok = answer.ok ?? !answer.error;
    this.emit({ type: "status", id, phase: "idle" });
    this.emit({ type: "done", id, ok, durationMs: 0 });
    return { ok, output: chunks.join(""), stderr: [answer.stderr ?? "", answer.error ?? ""].join(""), value: answer.value ?? "", error: answer.error ?? "", durationMs: 0 };
  }
  stop(): void {
    this.restart();
  }
  restart(): void {
    this.restarts++;
    this.emit({ type: "status", phase: "idle", detail: "Run-time restarted" });
  }
  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }
}

/** Opens scripted run-times and keeps every one it opened, so a test can script and inspect them. */
export class ScriptedCodeRuntimePort implements CodeRuntimePort {
  readonly opened: ScriptedCodeRuntime[] = [];
  constructor(private readonly answers: ScriptedExecution[] = []) {}
  open(options: CodeRuntimeOptions): ScriptedCodeRuntime {
    const runtime = new ScriptedCodeRuntime(options).script(...this.answers);
    this.opened.push(runtime);
    return runtime;
  }
}

/** Shared snippets in memory, stamped by the clock. */
export class InMemorySnippetStore implements SnippetStore {
  readonly rows: SharedSnippet[] = [];
  private nextId = 1;
  constructor(private readonly clock: Clock = new FixedClock()) {}
  async add(snippet: NewSnippet): Promise<string> {
    if (!snippet.courseId || !snippet.learnerId || !snippet.content) throw new Error("a snippet needs a course, a learner and a body");
    const id = `snippet-${this.nextId++}`;
    this.rows.push({ ...snippet, id, createdAt: this.clock.now().toISOString(), avatarUrl: null });
    return id;
  }
  async active(courseId: string, nowIso: string): Promise<SharedSnippet[]> {
    return this.rows
      .filter((row) => row.courseId === courseId && row.expiresAt > nowIso)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .map((row) => ({ ...row }));
  }
  async countSince(courseId: string, learnerId: string, sinceIso: string): Promise<number | null> {
    return this.rows.filter((row) => row.courseId === courseId && row.learnerId === learnerId && row.createdAt >= sinceIso).length;
  }
}

/** Delivers course notices to listeners in the same process, and keeps what was posted. */
export class InMemoryCourseNotices implements CourseNotices {
  readonly posted: CourseNotice[] = [];
  private readonly listeners = new Map<string, Set<(notice: CourseNotice) => void>>();
  /** When false, posting is refused: the composition without a broker. */
  constructor(private readonly configured = true) {}
  async post(notice: CourseNotice): Promise<boolean> {
    if (!this.configured || !notice.courseId) return false;
    this.posted.push(notice);
    for (const listener of this.listeners.get(`${notice.courseId}\t${notice.type}`) ?? []) listener(notice);
    return true;
  }
  watch(courseId: string, type: CourseNoticeType, listener: (notice: CourseNotice) => void): Unsubscribe {
    const key = `${courseId}\t${type}`;
    const set = this.listeners.get(key) ?? new Set();
    set.add(listener);
    this.listeners.set(key, set);
    return () => void set.delete(listener);
  }
}
