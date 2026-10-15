/**
 * The driven adapters this state adapter calls the use cases with. Each app's composition root
 * installs them with `configureAdapters` before anything else runs; until then, and in the
 * anonymous reader, the in-memory set is in place: nothing is recorded, nobody is present, sign-in
 * does not exist. No service in this package reads the environment; that is the root's job.
 */
import type {
  AccessStore,
  AssistanceFeed,
  Clock,
  CodeRuntimePort,
  ContentRenderer,
  CourseNotices,
  CourseSource,
  EventPublisher,
  HelpDesk,
  IdentityClient,
  LearningEventSink,
  PlaygroundLive,
  PlaygroundSnapshots,
  LiveEventReporter,
  NotesStore,
  PresencePort,
  ProfilePort,
  ScormRecords,
  WorkspaceStore,
  SnippetStore,
  WhiteboardStore
} from "@tutors/application/ports";
import {
  InMemoryAccessStore,
  InMemoryAssistanceFeed,
  InMemoryCourseNotices,
  InMemoryCourseSource,
  InMemorySnippetStore,
  InMemoryLearningEventSink,
  InMemoryNotesStore,
  InMemoryPlaygroundLive,
  InMemoryPlaygroundSnapshots,
  InMemoryPresence,
  InMemoryProfile,
  InMemoryScormRecords,
  InMemoryWhiteboardStore,
  InMemoryWorkspaceStore,
  PassThroughRenderer,
  RecordingLiveEventReporter,
  RecordingPublisher,
  ScriptedCodeRuntimePort,
  SignedOutHelpDesk
} from "@tutors/application/testing";

export type Adapters = {
  /** True when the app runs with no learner record at all: nothing recorded, nobody present, no sign-in. */
  anonymous: boolean;
  clock: Clock;
  renderer: ContentRenderer;
  courseSource: CourseSource;
  learningEvents: LearningEventSink;
  presence: PresencePort;
  /** The learner's record before they sign in (the browser's), and once they have (the store's). */
  profile: { local: ProfilePort; signedIn: ProfilePort | null };
  accessStore: AccessStore;
  publisher: EventPublisher;
  /** Where a learner's shared snippet goes (the reader's server, in the browser). */
  snippets: SnippetStore;
  /** Lecturer broadcasts and snippet pings, per course. */
  notices: CourseNotices;
  /** Tutors Live's view of this session: anonymous events, counted whether or not anyone is signed in. */
  liveEvents: LiveEventReporter;
  identityClient: IdentityClient | null;
  /** Where student code runs (playgrounds, notebook cells). */
  codeRuntime: CodeRuntimePort;
  /** Where a student's playground edits are kept between visits. */
  workspaces: WorkspaceStore;
  /** An imported SCORM package's run-time state, per learner. */
  scormRecords: ScormRecords;
  /** Playground workspaces handed in to a lecturer. */
  playgroundSnapshots: PlaygroundSnapshots;
  /** A lecturer watching a playground as it is typed. */
  playgroundLive: PlaygroundLive;
  /** Where whiteboard scenes are kept: the reader's data API once signed in, memory otherwise. */
  whiteboard: WhiteboardStore;
  /** A learner's private notes per lab step: the browser's storage, never a server (Rule 0380). */
  notes: NotesStore;
  /**
   * A course's help queue as it changes, for an educator's page: Tutors Live streams it from the
   * reader with the lecturer's session. A student's reader never joins it (Rule 0392), so the reader
   * composes none; publishing is the reader server's.
   */
  assistanceFeed: AssistanceFeed;
  /**
   * Help requests as the person signed in: a student asks from a lab step, a lecturer works the
   * queue in Tutors Live. The browser only asks; the reader's server keeps and moves requests
   * (Rule 0390). With nobody to sign in, every ask is refused.
   */
  helpDesk: HelpDesk;
};

const systemClock: Clock = { now: () => new Date(), nowMs: () => Date.now() };

/** The set for a reader with nobody to record: what `PUBLIC_ANON_MODE` composes, and what tests start from. */
export function anonymousAdapters(overrides: Partial<Adapters> = {}): Adapters {
  const profile = new InMemoryProfile();
  return {
    anonymous: true,
    clock: systemClock,
    renderer: new PassThroughRenderer(),
    courseSource: new InMemoryCourseSource(),
    learningEvents: new InMemoryLearningEventSink(),
    presence: new InMemoryPresence(systemClock),
    profile: { local: profile, signedIn: null },
    accessStore: new InMemoryAccessStore(systemClock),
    publisher: new RecordingPublisher(),
    snippets: new InMemorySnippetStore(systemClock),
    notices: new InMemoryCourseNotices(false),
    // Disabled, like a reporter with no endpoint: a reader nobody pointed at Tutors Live reports nothing.
    liveEvents: new RecordingLiveEventReporter(false),
    identityClient: null,
    codeRuntime: new ScriptedCodeRuntimePort(),
    workspaces: new InMemoryWorkspaceStore(),
    scormRecords: new InMemoryScormRecords(),
    // Nobody is signed in, so there is nobody to hand work in as.
    playgroundSnapshots: new InMemoryPlaygroundSnapshots({ enabled: false }),
    playgroundLive: new InMemoryPlaygroundLive(),
    whiteboard: new InMemoryWhiteboardStore(),
    notes: new InMemoryNotesStore(),
    assistanceFeed: new InMemoryAssistanceFeed(false),
    helpDesk: new SignedOutHelpDesk(),
    ...overrides
  };
}

let current: Adapters = anonymousAdapters();

/** Install the adapters; anything left out keeps its current value. */
export function configureAdapters(adapters: Partial<Adapters>): Adapters {
  current = { ...current, ...adapters };
  return current;
}

export function adapters(): Adapters {
  return current;
}
