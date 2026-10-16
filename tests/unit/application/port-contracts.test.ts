/**
 * Every port's contract suite, run against the in-memory adapter the anonymous reader and the tests
 * compose, and against the other adapters that need no network: the two cannot drift. The Supabase
 * adapters run the same suites in tests/contract against recorded clients.
 */
import { describe, it } from "vitest";
import {
  accessStoreContract,
  codeRuntimeContract,
  courseNoticesContract,
  eventPublisherContract,
  InMemoryAccessStore,
  InMemoryCourseNotices,
  InMemoryLearningEventSink,
  InMemoryPlaygroundLive,
  InMemoryPlaygroundSnapshots,
  InMemoryPresence,
  InMemoryProfile,
  InMemoryScormRecords,
  InMemoryWorkspaceStore,
  InMemorySnippetStore,
  learningEventSinkContract,
  playgroundLiveContract,
  playgroundSnapshotsContract,
  presenceContract,
  profileContract,
  RecordingPublisher,
  ScriptedCodeRuntime,
  scormRecordsContract,
  workspaceStoreContract,
  snippetStoreContract,
  assistanceFeedContract,
  assistanceStoreContract,
  helpDeskContract,
  feedbackDeskContract,
  feedbackStoreContract,
  InMemoryAssistanceFeed,
  InMemoryHelpDesk,
  InMemoryFeedbackDesk,
  InMemoryAssistanceStore,
  InMemoryFeedbackStore,
  InMemoryInsightsRead,
  InMemoryNotesStore,
  insightsReadContract,
  notesStoreContract,
  type ContractCase
} from "@tutors/application/testing";
import { localStorageProfile, type KeyValueStorage } from "@tutors/profile-localstorage";
import { localStorageNotes, type NotesStorage } from "@tutors/notes-localstorage";
import { inProcessPublisher } from "@tutors/bus-inprocess";

function contract(name: string, cases: ContractCase[]) {
  describe(name, () => {
    for (const c of cases) it(c.name, c.run);
  });
}

function memoryStorage(): KeyValueStorage {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key)
  };
}

/** A Storage with the key listing the notes adapter walks for a course's notes. */
function listedStorage(): NotesStorage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    key: (i) => [...items.keys()][i] ?? null,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key)
  };
}

/** localStorage holds one learner's record, so the per-learner cases are read for that one learner. */
const singleLearnerCases = (cases: ContractCase[]) => cases.filter((c) => !/per learner/.test(c.name));

contract(
  "ProfilePort: in memory",
  profileContract(() => new InMemoryProfile())
);
contract(
  "ProfilePort: localStorage",
  singleLearnerCases(
    profileContract(() => {
      const storage = memoryStorage();
      return localStorageProfile(() => storage);
    })
  )
);
contract(
  "AccessStore: in memory",
  accessStoreContract(() => new InMemoryAccessStore())
);
contract(
  "PresencePort: in memory",
  presenceContract(() => new InMemoryPresence())
);
contract(
  "EventPublisher: in memory",
  eventPublisherContract(() => new RecordingPublisher())
);
contract(
  "EventPublisher: in process",
  eventPublisherContract(() => inProcessPublisher())
);
contract(
  "LearningEventSink: in memory",
  learningEventSinkContract(() => new InMemoryLearningEventSink())
);
contract(
  "WorkspaceStore: in memory",
  workspaceStoreContract(() => new InMemoryWorkspaceStore())
);
contract(
  "ScormRecords: in memory",
  scormRecordsContract(() => new InMemoryScormRecords())
);
contract(
  "PlaygroundSnapshots: in memory",
  playgroundSnapshotsContract(() => new InMemoryPlaygroundSnapshots({ enabled: true, reviews: ["cs101"] }))
);
contract(
  "PlaygroundLive: in memory",
  playgroundLiveContract(() => new InMemoryPlaygroundLive())
);
contract(
  "CodeRuntime: scripted",
  codeRuntimeContract(() => new ScriptedCodeRuntime({ runtime: "python" }).script({ stdout: "1\n" }))
);
contract(
  "SnippetStore: in memory",
  snippetStoreContract(() => new InMemorySnippetStore())
);
contract(
  "CourseNotices: in memory",
  courseNoticesContract(() => new InMemoryCourseNotices())
);
contract(
  "AssistanceStore: in memory",
  assistanceStoreContract(() => new InMemoryAssistanceStore())
);
contract(
  "AssistanceFeed: in memory",
  assistanceFeedContract(() => new InMemoryAssistanceFeed())
);
contract(
  "HelpDesk: in memory",
  helpDeskContract(() => {
    const desk = new InMemoryHelpDesk({ educators: { cs101: ["ellen"] } });
    return { student: desk.as({ login: "alice", name: "Alice" }), educator: desk.as({ login: "ellen", name: "Ellen" }), visitor: desk };
  })
);
contract(
  "FeedbackStore: in memory",
  feedbackStoreContract(() => new InMemoryFeedbackStore())
);
contract(
  "FeedbackDesk: in memory",
  feedbackDeskContract(() => {
    const desk = new InMemoryFeedbackDesk({ educators: { cs101: ["ellen"] } });
    return {
      student: desk.as({ login: "alice", name: "Alice" }),
      other: desk.as({ login: "bob", name: "Bob" }),
      educator: desk.as({ login: "ellen", name: "Ellen" }),
      visitor: desk
    };
  })
);
contract(
  "NotesStore: in memory",
  notesStoreContract(() => new InMemoryNotesStore())
);
contract(
  "NotesStore: localStorage",
  notesStoreContract(() => {
    const storage = listedStorage();
    return localStorageNotes(() => storage);
  })
);
contract(
  "InsightsRead: in memory",
  insightsReadContract(({ requests, annotations, reflections }) => new InMemoryInsightsRead(requests, annotations, reflections))
);
