/**
 * A contract suite is only worth running if it fails a faulty adapter. Each case here runs a
 * suite from @tutors/application/testing against an adapter with one deliberate fault (it
 * ignores which course or exercise a message is for, cannot unsubscribe, or accepts anything)
 * and checks the suite names the fault, while still passing the cases the fault does not touch.
 */
import { describe, expect, it } from "vitest";
import {
  ContractFailure,
  courseNoticesContract,
  InMemorySnippetStore,
  playgroundLiveContract,
  presenceContract,
  snippetStoreContract,
  type ContractCase
} from "@tutors/application/testing";
import type { CourseNotice, CourseNotices, PlaygroundLive, PlaygroundLiveState, PresencePort, SnippetStore } from "@tutors/application/ports";

async function outcome(c: ContractCase): Promise<"passes" | string> {
  try {
    await c.run();
    return "passes";
  } catch (error) {
    expect(error).toBeInstanceOf(ContractFailure);
    return (error as Error).message;
  }
}

async function outcomes(cases: ContractCase[]): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const c of cases) result[c.name] = await outcome(c);
  return result;
}

describe("playgroundLiveContract", () => {
  /** One room for every exercise: every share announces itself, every state goes to every watcher, and nothing ever stops. */
  function partyLine(): PlaygroundLive {
    const watchers: Array<(state: PlaygroundLiveState) => void> = [];
    const sharers: Array<() => void> = [];
    return {
      share: (_courseId, _loId, onWatcher) => {
        sharers.push(onWatcher);
        onWatcher();
        return { send: (state) => watchers.forEach((w) => w(state)), stop: () => {} };
      },
      watch: (_courseId, _loId, onState) => {
        watchers.push(onState);
        sharers.forEach((s) => s());
        onState({ studentId: "ghost", studentName: "ghost", files: [], activePath: "", output: "", running: false, updatedAt: "" });
        return () => {};
      }
    };
  }

  it("fails an adapter that leaks state across exercises and past stop", async () => {
    const result = await outcomes(playgroundLiveContract(partyLine));
    expect(Object.values(result)).toEqual([
      'watched exercise: expected ["ada"], got ["ghost","ada"]',
      "passes",
      'nothing after stop: expected [], got ["ghost","ada","ada"]'
    ]);
  });
});

describe("snippetStoreContract", () => {
  it("fails a store that keeps a snippet with no course, learner or body", async () => {
    const lax = (): SnippetStore => {
      const inner = new InMemorySnippetStore();
      let n = 0;
      return { add: async () => `lax-${++n}`, active: (c, now) => inner.active(c, now), countSince: (c, l, s) => inner.countSince(c, l, s) };
    };
    const cases = snippetStoreContract(lax);
    const rejecting = cases.find((c) => c.name === "a snippet without a course, a learner or a body is rejected")!;
    expect(await outcome(rejecting)).toBe("rejected: expected 3, got 0");
  });
});

describe("courseNoticesContract", () => {
  /** Delivers every notice to every watcher, and unsubscribing does nothing. */
  function shoutingNotices(): CourseNotices {
    const listeners: Array<(notice: CourseNotice) => void> = [];
    return {
      post: async (notice) => {
        listeners.forEach((l) => l(notice));
        return true;
      },
      watch: (_courseId, _type, listener) => {
        listeners.push(listener);
        return () => {};
      }
    };
  }

  it("fails an adapter that ignores course, type and unsubscribe", async () => {
    const result = await outcomes(courseNoticesContract(shoutingNotices));
    expect(result["a posted notice reaches a watcher of its course and type"]).toBe("passes");
    expect(result["a watcher of another course or another type hears nothing"]).toMatch(/^heard: expected \[\], got \[.+\]$/);
    expect(result["a watcher that unsubscribed hears nothing more"]).toMatch(/^heard: expected \[\], got \[.+\]$/);
    expect(result["a notice without a course is refused"]).toBe("refused: expected false, got true");
  });
});

describe("presenceContract", () => {
  it("fails an adapter that cannot list recent presence", async () => {
    const forgetful: PresencePort = { publish: async () => {}, subscribe: () => () => {}, recent: async () => null };
    const result = await outcomes(presenceContract(() => forgetful));
    expect(result["the latest snapshot per learner per course is kept, newest first"]).toBe('learners: expected ["ann","bob"], got []');
    expect(result["a course nobody has been in lists nobody"]).toBe("recent: expected [], got null");
  });
});
