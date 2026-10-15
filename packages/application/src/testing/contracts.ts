/**
 * Contract suites: the behaviour every adapter of a port must show, as plain async cases with no
 * test framework in them. A test file runs them against the in-memory adapter and against a real
 * one (recorded Supabase, a fixture server), so the two cannot drift.
 */
import type { PresenceEvent } from "@tutors/domain/presence";
import type { AccessStore } from "../ports/access-store.ts";
import type { EventPublisher } from "../ports/event-publisher.ts";
import type { PresencePort } from "../ports/presence.ts";
import type { ProfilePort } from "../ports/profile.ts";
import type { LearningEventSink } from "../ports/learning-event-sink.ts";
import type { WorkspaceStore } from "../ports/workspace-store.ts";
import type { ScormRecords } from "../ports/scorm-records.ts";
import { SNAPSHOT_OUTPUT_LIMIT, type PlaygroundSnapshots } from "../ports/playground-snapshots.ts";
import type { PlaygroundLive, PlaygroundLiveState } from "../ports/playground-live.ts";
import type { CodeRuntime } from "../ports/code-runtime.ts";

export type ContractCase = { name: string; run: () => Promise<void> };

export class ContractFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractFailure";
  }
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ContractFailure(message);
}

export function assertEqual<T>(actual: T, expected: T, message: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new ContractFailure(`${message}: expected ${e}, got ${a}`);
}

type Make<T> = () => T | Promise<T>;

const visit = (id: string, lastVisit = "2026-01-05T09:00:00.000Z") => ({ id, title: id.toUpperCase(), lastVisit, credits: "5", visits: 1 });

export function profileContract(make: Make<ProfilePort>): ContractCase[] {
  return [
    {
      name: "a learner with no record has no visits, sentiment or sharing",
      run: async () => {
        const profile = await make();
        assertEqual(await profile.getCourseVisits("nobody"), [], "visits");
        assertEqual(await profile.getSentiment("nobody"), null, "sentiment");
        assertEqual(await profile.getSharing("nobody"), null, "sharing");
      }
    },
    {
      name: "saved visits read back in order, per learner",
      run: async () => {
        const profile = await make();
        await profile.saveCourseVisits("ann", [visit("b"), visit("a")]);
        await profile.saveCourseVisits("bob", [visit("c")]);
        assertEqual((await profile.getCourseVisits("ann")).map((v) => v.id), ["b", "a"], "ann's visits");
        assertEqual((await profile.getCourseVisits("bob")).map((v) => v.id), ["c"], "bob's visits");
      }
    },
    {
      name: "what is read back is a copy: changing it does not change what is stored",
      run: async () => {
        const profile = await make();
        await profile.saveCourseVisits("ann", [visit("a")]);
        const read = await profile.getCourseVisits("ann");
        read[0].favourite = true;
        read.push(visit("z"));
        assertEqual(await profile.getCourseVisits("ann"), [visit("a")], "stored visits");
      }
    },
    {
      name: "sentiment and sharing are kept per learner and the last write wins",
      run: async () => {
        const profile = await make();
        await profile.setSentiment("ann", "confused");
        await profile.setSentiment("ann", "delighted");
        await profile.setSharing("ann", true);
        await profile.setSharing("ann", false);
        assertEqual(await profile.getSentiment("ann"), "delighted", "sentiment");
        assertEqual(await profile.getSharing("ann"), false, "sharing");
        assertEqual(await profile.getSentiment("bob"), null, "bob's sentiment");
      }
    },
    {
      name: "upserting a learner stores their sharing and leaves it alone when unstated",
      run: async () => {
        const profile = await make();
        await profile.upsertLearner({ login: "ann", name: "Ann", email: null, image: null, sentiment: null, sharing: true });
        assertEqual(await profile.getSharing("ann"), true, "sharing after upsert");
        await profile.upsertLearner({ login: "ann", name: "Ann", email: null, image: null, sentiment: null, sharing: null });
        assertEqual(await profile.getSharing("ann"), true, "sharing after unstated upsert");
      }
    }
  ];
}

export function accessStoreContract(make: Make<AccessStore>): ContractCase[] {
  return [
    {
      name: "a course with no locks has none",
      run: async () => {
        const store = await make();
        assertEqual(await store.locks("cs101"), [], "locks");
      }
    },
    {
      name: "a lock is kept per course and route, and the last write wins",
      run: async () => {
        const store = await make();
        assert(await store.setLock("cs101", "/lab/cs101/week-01", true, "lecturer"), "first write");
        assert(await store.setLock("cs101", "/lab/cs101/week-01", false, "lecturer"), "second write");
        assert(await store.setLock("cs102", "/lab/cs102/week-01", true, "lecturer"), "other course");
        const locks = await store.locks("cs101");
        assertEqual(locks.map((l) => [l.lo_route, l.locked, l.locked_by]), [["/lab/cs101/week-01", false, "lecturer"]], "cs101 locks");
      }
    },
    {
      name: "a removed lock is gone; removing again changes nothing",
      run: async () => {
        const store = await make();
        await store.setLock("cs101", "/lab/cs101/week-01", true, "lecturer");
        assert(await store.removeLock("cs101", "/lab/cs101/week-01"), "remove");
        assertEqual(await store.locks("cs101"), [], "locks after remove");
        assertEqual(await store.removeLock("cs101", "/lab/cs101/week-01"), false, "remove again");
      }
    },
    {
      name: "nothing is written without a course, a route and a lecturer",
      run: async () => {
        const store = await make();
        assertEqual(await store.setLock("", "/lab/x", true, "lecturer"), false, "no course");
        assertEqual(await store.setLock("cs101", "", true, "lecturer"), false, "no route");
        assertEqual(await store.setLock("cs101", "/lab/x", true, ""), false, "no lecturer");
        assertEqual(await store.locks("cs101"), [], "locks");
      }
    }
  ];
}

const event = (courseId: string, id: string, loRoute = "/topic/x"): PresenceEvent => ({
  courseId,
  courseUrl: `${courseId}.netlify.app`,
  courseTitle: courseId,
  loRoute,
  title: "x",
  isPrivate: false,
  type: "topic",
  user: { id, fullName: id, avatar: "", sentiment: "neutral" }
});

export function presenceContract(make: Make<PresencePort>, sinceIso = "2000-01-01T00:00:00.000Z"): ContractCase[] {
  return [
    {
      name: "a course nobody has been in lists nobody",
      run: async () => {
        const presence = await make();
        assertEqual(await presence.recent("empty", sinceIso), [], "recent");
      }
    },
    {
      name: "the latest snapshot per learner per course is kept, newest first",
      run: async () => {
        const presence = await make();
        await presence.publish(event("cs101", "ann", "/topic/1"));
        await presence.publish(event("cs101", "bob", "/topic/2"));
        await presence.publish(event("cs101", "ann", "/topic/3"));
        await presence.publish(event("cs102", "cat"));
        const rows = (await presence.recent("cs101", sinceIso)) ?? [];
        const seen = rows.map((r) => (r.payload as PresenceEvent).user?.id).sort();
        assertEqual(seen, ["ann", "bob"], "learners");
        const ann = rows.map((r) => r.payload as PresenceEvent).find((e) => e.user?.id === "ann");
        assertEqual(ann?.loRoute, "/topic/3", "ann's latest");
      }
    },
    {
      name: "a course subscriber hears that course only; unsubscribing stops it",
      run: async () => {
        const presence = await make();
        const heard: string[] = [];
        const stop = presence.subscribe((e) => heard.push(`${e.courseId}:${e.user?.id}`), "cs101");
        await presence.publish(event("cs101", "ann"));
        await presence.publish(event("cs102", "bob"));
        stop();
        await presence.publish(event("cs101", "cat"));
        await new Promise((r) => setTimeout(r, 0));
        assertEqual(heard, ["cs101:ann"], "heard");
      }
    }
  ];
}

export function eventPublisherContract(make: Make<EventPublisher>): ContractCase[] {
  return [
    {
      name: "every subscriber hears every event, in order, until it unsubscribes",
      run: async () => {
        const bus = await make();
        const a: string[] = [];
        const b: string[] = [];
        const stopA = bus.subscribe((e) => a.push(e.type));
        bus.subscribe((e) => b.push(e.type));
        await bus.publish({ type: "presence", event: event("cs101", "ann") });
        stopA();
        await bus.publish({ type: "learning", learnerId: "ann", event: { kind: "tick", courseId: "cs101", loId: null, day: "2026-01-05" } });
        assertEqual(a, ["presence"], "a");
        assertEqual(b, ["presence", "learning"], "b");
      }
    },
    {
      name: "publishing with no subscriber is not an error",
      run: async () => {
        const bus = await make();
        await bus.publish({ type: "presence", event: event("cs101", "ann") });
      }
    }
  ];
}

export function learningEventSinkContract(make: Make<LearningEventSink>): ContractCase[] {
  return [
    {
      name: "a page load and a tick are both accepted for a learner",
      run: async () => {
        const sink = await make();
        await sink.record({ kind: "page-load", courseId: "cs101", loId: "/topic/cs101/1", loType: "topic", day: "2026-01-05" }, "ann");
        await sink.record({ kind: "tick", courseId: "cs101", loId: null, day: "2026-01-05" }, "ann");
      }
    }
  ];
}

export function workspaceStoreContract(make: Make<WorkspaceStore>): ContractCase[] {
  const workspace = (content: string) => ({ courseId: "cs101", loId: "/playground/cs101/topic/hello", files: [{ path: "main.py", content }], entry: "main.py", updatedAt: "2026-09-10T09:00:00.000Z" });
  return [
    {
      name: "an exercise never saved has no workspace",
      run: async () => {
        const store = await make();
        assertEqual(await store.load("cs101", "/playground/cs101/topic/hello"), null, "load");
      }
    },
    {
      name: "a saved workspace comes back per course and exercise, and the last save wins",
      run: async () => {
        const store = await make();
        await store.save(workspace("print(1)"));
        await store.save(workspace("print(2)"));
        await store.save({ ...workspace("other"), loId: "/playground/cs101/topic/other" });
        assertEqual((await store.load("cs101", "/playground/cs101/topic/hello"))?.files, [{ path: "main.py", content: "print(2)" }], "files");
      }
    },
    {
      name: "a removed workspace is gone; removing again changes nothing",
      run: async () => {
        const store = await make();
        await store.save(workspace("print(1)"));
        await store.remove("cs101", "/playground/cs101/topic/hello");
        await store.remove("cs101", "/playground/cs101/topic/hello");
        assertEqual(await store.load("cs101", "/playground/cs101/topic/hello"), null, "load after remove");
      }
    }
  ];
}

export function scormRecordsContract(make: Make<ScormRecords>): ContractCase[] {
  const summary = { completionStatus: "incomplete", successStatus: "unknown", totalTime: 30, location: "page-2" };
  const record = (cmi: Record<string, string>, learnerId = "ada") => ({ courseId: "cs101", learnerId, loId: "/scorm/cs101/topic/quiz", version: "1.2" as const, cmi, summary });
  return [
    {
      name: "a first attempt starts from an empty data model",
      run: async () => {
        const records = await make();
        assertEqual(await records.load("cs101", "ada", "/scorm/cs101/topic/quiz"), {}, "first attempt");
      }
    },
    {
      name: "the whole data model is kept per learner and the last save wins",
      run: async () => {
        const records = await make();
        await records.save(record({ "cmi.core.lesson_location": "page-1", "cmi.suspend_data": "a=1" }));
        await records.save(record({ "cmi.core.lesson_location": "page-2", "cmi.suspend_data": "a=2" }));
        await records.save(record({ "cmi.core.lesson_location": "page-9" }, "bob"));
        assertEqual(await records.load("cs101", "ada", "/scorm/cs101/topic/quiz"), { "cmi.core.lesson_location": "page-2", "cmi.suspend_data": "a=2" }, "ada");
        assertEqual(await records.load("cs101", "bob", "/scorm/cs101/topic/quiz"), { "cmi.core.lesson_location": "page-9" }, "bob");
      }
    },
    {
      name: "nothing is kept without a course, a learner and a learning object",
      run: async () => {
        const records = await make();
        await records.save({ ...record({ "cmi.core.lesson_location": "x" }), learnerId: "" });
        assertEqual(await records.load("cs101", "", "/scorm/cs101/topic/quiz"), {}, "no learner");
        assertEqual(await records.load("", "ada", "/scorm/cs101/topic/quiz"), {}, "no course");
      }
    }
  ];
}

export function playgroundSnapshotsContract(make: Make<PlaygroundSnapshots>): ContractCase[] {
  const snapshot = (studentId = "ada", lastOutput = "1\n") => ({
    studentId,
    studentName: studentId.toUpperCase(),
    courseId: "cs101",
    loId: "/playground/cs101/topic/hello",
    runtime: "python",
    entry: "main.py",
    files: [{ path: "main.py", content: "print(1)" }],
    lastOutput,
    lastOk: true
  });
  return [
    {
      name: "a student who has handed in nothing has no snapshot",
      run: async () => {
        const snapshots = await make();
        assertEqual(await snapshots.get("cs101", "/playground/cs101/topic/hello", "ada"), null, "get");
        assertEqual(await snapshots.list("cs101", "/playground/cs101/topic/hello"), [], "list");
      }
    },
    {
      name: "a handed-in workspace comes back whole, with what it printed, and the last hand-in wins",
      run: async () => {
        const snapshots = await make();
        assert(await snapshots.save(snapshot("ada", "first\n")), "first save");
        assert(await snapshots.save(snapshot("ada", "second\n")), "second save");
        const stored = await snapshots.get("cs101", "/playground/cs101/topic/hello", "ada");
        assertEqual(stored?.files, [{ path: "main.py", content: "print(1)" }], "files");
        assertEqual(stored?.lastOutput, "second\n", "output");
        assertEqual(stored?.lastOk, true, "verdict");
        assertEqual((await snapshots.list("cs101", "/playground/cs101/topic/hello")).length, 1, "one row per student");
      }
    },
    {
      name: "a runaway run's output is cut to the limit rather than stored whole",
      run: async () => {
        const snapshots = await make();
        await snapshots.save(snapshot("ada", "x".repeat(SNAPSHOT_OUTPUT_LIMIT + 5000)));
        assertEqual((await snapshots.get("cs101", "/playground/cs101/topic/hello", "ada"))?.lastOutput.length, SNAPSHOT_OUTPUT_LIMIT, "output length");
      }
    },
    {
      name: "a removed snapshot is gone",
      run: async () => {
        const snapshots = await make();
        await snapshots.save(snapshot("ada"));
        await snapshots.remove("cs101", "/playground/cs101/topic/hello", "ada");
        assertEqual(await snapshots.get("cs101", "/playground/cs101/topic/hello", "ada"), null, "get after remove");
      }
    }
  ];
}

export function playgroundLiveContract(make: Make<PlaygroundLive>): ContractCase[] {
  const state = (studentId: string): PlaygroundLiveState => ({ studentId, studentName: studentId, files: [{ path: "main.py", content: "print(1)" }], activePath: "main.py", output: "", running: false, updatedAt: "2026-09-10T09:00:00.000Z" });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return [
    {
      name: "a sharing student's state reaches a lecturer watching the same exercise, and no other",
      run: async () => {
        const live = await make();
        const seen: string[] = [];
        const elsewhere: string[] = [];
        const stopWatching = live.watch("cs101", "/playground/cs101/topic/hello", (s) => seen.push(s.studentId));
        const stopOther = live.watch("cs101", "/playground/cs101/topic/other", (s) => elsewhere.push(s.studentId));
        const share = live.share("cs101", "/playground/cs101/topic/hello", () => {});
        share.send(state("ada"));
        await settle();
        assertEqual(seen, ["ada"], "watched exercise");
        assertEqual(elsewhere, [], "other exercise");
        share.stop();
        stopWatching();
        stopOther();
      }
    },
    {
      name: "a lecturer's arrival is announced to the students sharing",
      run: async () => {
        const live = await make();
        let announced = 0;
        const share = live.share("cs101", "/playground/cs101/topic/hello", () => announced++);
        const stop = live.watch("cs101", "/playground/cs101/topic/hello", () => {});
        await settle();
        assert(announced >= 1, "announced");
        share.stop();
        stop();
      }
    },
    {
      name: "after stopping, nothing more is delivered either way",
      run: async () => {
        const live = await make();
        const seen: string[] = [];
        const stop = live.watch("cs101", "/playground/cs101/topic/hello", (s) => seen.push(s.studentId));
        const share = live.share("cs101", "/playground/cs101/topic/hello", () => {});
        stop();
        share.send(state("ada"));
        await settle();
        share.stop();
        share.send(state("ada"));
        await settle();
        assertEqual(seen, [], "nothing after stop");
      }
    }
  ];
}

export function codeRuntimeContract(make: Make<CodeRuntime>): ContractCase[] {
  const request = { runtime: "python" as const, mode: "script" as const, files: [{ path: "main.py", content: "print(1)" }], entry: "main.py" };
  return [
    {
      name: "a run gathers its output in order and reports whether it succeeded",
      run: async () => {
        const runtime = await make();
        const streamed: string[] = [];
        runtime.subscribe((event) => void (event.type === "stream" && streamed.push(event.text)));
        const result = await runtime.execute(request);
        assertEqual(result.output, streamed.join(""), "output is the streamed text");
        assertEqual(typeof result.ok, "boolean", "verdict");
        runtime.dispose();
      }
    },
    {
      name: "a disposed run-time refuses to run anything",
      run: async () => {
        const runtime = await make();
        runtime.dispose();
        let refused = false;
        try {
          await runtime.execute(request);
        } catch {
          refused = true;
        }
        assert(refused, "execute after dispose");
      }
    }
  ];
}
