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
import type { SnippetStore } from "../ports/snippet-store.ts";
import type { CourseNotice, CourseNotices } from "../ports/course-notices.ts";

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

const snippet = (courseId: string, learnerId: string, expiresAt: string, content = "TypeError: x is undefined") => ({
  courseId,
  learnerId,
  learnerName: learnerId.toUpperCase(),
  filename: "error.txt",
  content,
  title: null,
  loRoute: null,
  loTitle: null,
  expiresAt
});

/**
 * `now` is an instant between the snippets the cases add (they expire a day either side of it), so a
 * real adapter can run the suite against rows stamped by its own clock.
 */
export function snippetStoreContract(make: Make<SnippetStore>, now = "2026-01-05T09:00:00.000Z"): ContractCase[] {
  const before = new Date(Date.parse(now) - 24 * 60 * 60 * 1000).toISOString();
  const after = new Date(Date.parse(now) + 24 * 60 * 60 * 1000).toISOString();
  return [
    {
      name: "a course nobody shared with has no active snippets",
      run: async () => {
        const store = await make();
        assertEqual(await store.active("cs101", now), [], "active");
      }
    },
    {
      name: "an added snippet is active for its course, with the fields it was given",
      run: async () => {
        const store = await make();
        const id = await store.add(snippet("cs101", "alice", after));
        assert(typeof id === "string" && id.length > 0, "id");
        const rows = await store.active("cs101", now);
        assertEqual(rows.map((r) => [r.id, r.learnerId, r.learnerName, r.filename, r.content, r.expiresAt]), [[id, "alice", "ALICE", "error.txt", "TypeError: x is undefined", after]], "rows");
        assertEqual(await store.active("cs102", now), [], "another course");
      }
    },
    {
      name: "an expired snippet is not active",
      run: async () => {
        const store = await make();
        await store.add(snippet("cs101", "alice", before, "old"));
        await store.add(snippet("cs101", "bob", after, "new"));
        assertEqual((await store.active("cs101", now)).map((r) => r.content), ["new"], "active");
      }
    },
    {
      name: "the count of a learner's recent snippets is per course and per learner",
      run: async () => {
        const store = await make();
        await store.add(snippet("cs101", "alice", after));
        await store.add(snippet("cs101", "alice", after));
        await store.add(snippet("cs101", "bob", after));
        await store.add(snippet("cs102", "alice", after));
        assertEqual(await store.countSince("cs101", "alice", "2000-01-01T00:00:00.000Z"), 2, "alice in cs101");
        assertEqual(await store.countSince("cs101", "carol", "2000-01-01T00:00:00.000Z"), 0, "nobody");
      }
    },
    {
      name: "a snippet without a course, a learner or a body is rejected",
      run: async () => {
        const store = await make();
        let rejected = 0;
        for (const bad of [snippet("", "alice", after), snippet("cs101", "", after), snippet("cs101", "alice", after, "")]) {
          await store.add(bad).then(
            () => {},
            () => rejected++
          );
        }
        assertEqual(rejected, 3, "rejected");
        assertEqual(await store.active("cs101", now), [], "nothing kept");
      }
    }
  ];
}

const ping = (courseId: string, id: string): CourseNotice => ({ type: "gist-created", id, courseId, sentAt: 1 });

export function courseNoticesContract(make: Make<CourseNotices>): ContractCase[] {
  return [
    {
      name: "a posted notice reaches a watcher of its course and type",
      run: async () => {
        const notices = await make();
        const heard: CourseNotice[] = [];
        notices.watch("cs101", "gist-created", (notice) => heard.push(notice));
        assert(await notices.post(ping("cs101", "n1")), "posted");
        assertEqual(heard, [ping("cs101", "n1")], "heard");
      }
    },
    {
      name: "a watcher of another course or another type hears nothing",
      run: async () => {
        const notices = await make();
        const heard: CourseNotice[] = [];
        notices.watch("cs102", "gist-created", (notice) => heard.push(notice));
        notices.watch("cs101", "course:broadcast", (notice) => heard.push(notice));
        await notices.post(ping("cs101", "n1"));
        assertEqual(heard, [], "heard");
      }
    },
    {
      name: "a watcher that unsubscribed hears nothing more",
      run: async () => {
        const notices = await make();
        const heard: CourseNotice[] = [];
        const stop = notices.watch("cs101", "gist-created", (notice) => heard.push(notice));
        stop();
        await notices.post(ping("cs101", "n1"));
        assertEqual(heard, [], "heard");
      }
    },
    {
      name: "a notice without a course is refused",
      run: async () => {
        const notices = await make();
        assertEqual(await notices.post(ping("", "n1")), false, "refused");
      }
    }
  ];
}
