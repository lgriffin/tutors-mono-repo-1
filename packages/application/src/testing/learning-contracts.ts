/**
 * Contract suites for the assistance, feedback, notes and insights ports: what every adapter of
 * them must do, run against the in-memory adapters now and the real ones when they arrive.
 */
import { openRequest, type HelpRequest } from "@tutors/domain/assistance";
import type { Annotation, Reflection } from "@tutors/domain/feedback";
import type { Note, StepRef } from "@tutors/domain/learning";
import type { AssistanceChange, AssistanceFeed } from "../ports/assistance-feed.ts";
import type { AssistanceStore } from "../ports/assistance-store.ts";
import type { FeedbackStore } from "../ports/feedback-store.ts";
import type { HelpDesk, HelpDeskResult } from "../ports/help-desk.ts";
import type { InsightsRead } from "../ports/insights-read.ts";
import type { NotesStore } from "../ports/notes-store.ts";
import { assert, assertEqual, type ContractCase } from "./contracts.ts";

type Make<T> = () => T | Promise<T>;

const step = (courseId: string, stepId = "02", labRoute = "/lab/cs101/lab-01"): StepRef => ({ courseId, labRoute, stepId });
const ask = (courseId: string, learner: string, at = "2026-01-05T09:00:00.000Z") => openRequest(step(courseId), { login: learner, name: learner.toUpperCase() }, "stuck", at);

export function assistanceStoreContract(make: Make<AssistanceStore>): ContractCase[] {
  return [
    {
      name: "an opened request reads back by id with the fields it was given",
      run: async () => {
        const store = await make();
        const opened = await store.open(ask("cs101", "alice"));
        assert(typeof opened.id === "string" && opened.id.length > 0, "id");
        const read = await store.get(opened.id);
        assertEqual(
          read && [read.ref, read.learnerId, read.kind, read.state, read.requestedAt],
          [step("cs101"), "alice", "stuck", "open", "2026-01-05T09:00:00.000Z"],
          "read back"
        );
        assertEqual(await store.get("no-such-request"), null, "missing");
      }
    },
    {
      name: "live lists a course's open and acknowledged requests only",
      run: async () => {
        const store = await make();
        const a = await store.open(ask("cs101", "alice"));
        const b = await store.open(ask("cs101", "bob"));
        await store.open(ask("cs102", "carol"));
        assert(await store.replace({ ...b, state: "resolved", closed: { by: "lecturer", at: "2026-01-05T09:05:00.000Z", reason: "resolved" } }, b), "resolved");
        assertEqual(
          (await store.live("cs101")).map((r) => r.id),
          [a.id],
          "live in cs101"
        );
      }
    },
    {
      name: "replace writes only while the stored request still has the state it was read in",
      run: async () => {
        const store = await make();
        const r = await store.open(ask("cs101", "alice"));
        const acknowledged: HelpRequest = { ...r, state: "acknowledged", acknowledged: { by: "lecturer", at: "2026-01-05T09:01:00.000Z" } };
        assert(await store.replace(acknowledged, r), "first acknowledge");
        assertEqual(await store.replace(acknowledged, r), false, "second acknowledge");
        assertEqual(await store.replace({ ...r, id: "no-such-request" }, { ...r, id: "no-such-request" }), false, "missing");
        assertEqual((await store.get(r.id))?.acknowledged, { by: "lecturer", at: "2026-01-05T09:01:00.000Z" }, "kept");
      }
    },
    {
      name: "replace writes nothing over a request asked again on another kind or step since it was read",
      run: async () => {
        const store = await make();
        const r = await store.open(ask("cs101", "alice"));
        const askedAgain: HelpRequest = { ...r, kind: "hint", ref: step("cs101", "03") };
        assert(await store.replace(askedAgain, r), "asked again");
        const stale: HelpRequest = { ...r, state: "acknowledged", acknowledged: { by: "lecturer", at: "2026-01-05T09:01:00.000Z" } };
        assertEqual(await store.replace(stale, r), false, "acknowledge from the stale read");
        assertEqual(await store.get(r.id), askedAgain, "the student's ask kept");
      }
    },
    {
      name: "a second live request for the same learner and course is refused, and one is allowed again once the first has ended",
      run: async () => {
        const store = await make();
        const first = await store.open(ask("cs101", "alice"));
        let refused = false;
        await store.open(ask("cs101", "alice", "2026-01-05T09:01:00.000Z")).catch(() => (refused = true));
        assert(refused, "second live request refused");
        await store.open(ask("cs102", "alice"));
        assert(await store.replace({ ...first, state: "withdrawn", closed: { by: "alice", at: "2026-01-05T09:02:00.000Z", reason: "withdrawn" } }, first), "withdrawn");
        const again = await store.open(ask("cs101", "alice", "2026-01-05T09:03:00.000Z"));
        assertEqual(
          (await store.live("cs101")).map((r) => r.id),
          [again.id],
          "live after asking again"
        );
      }
    },
    {
      name: "every field of a moved request reads back as it was replaced",
      run: async () => {
        const store = await make();
        const r = await store.open({ ...ask("cs101", "alice"), kind: "hint" });
        const answered: HelpRequest = {
          ...r,
          ref: step("cs102", "03", "/lab/cs102/topic-02/book-b"),
          learnerId: "alice-2",
          learnerName: "Alice Two",
          requestedAt: "2026-01-05T09:00:30.000Z",
          state: "resolved",
          acknowledged: { by: "lecturer", at: "2026-01-05T09:01:00.000Z" },
          closed: { by: "lecturer", at: "2026-01-05T09:04:00.000Z", reason: "hint" },
          hintText: "Check the loop bound.",
          helped: true
        };
        assert(await store.replace(answered, r), "replaced");
        assertEqual(await store.get(r.id), answered, "read back");
      }
    },
    {
      name: "latest is the learner's most recently raised request in the course, in any state",
      run: async () => {
        const store = await make();
        assertEqual(await store.latest("cs101", "alice"), null, "none yet");
        const first = await store.open(ask("cs101", "alice"));
        assert(await store.replace({ ...first, state: "resolved", closed: { by: "ellen", at: "2026-01-05T09:05:00.000Z", reason: "resolved" } }, first), "resolved");
        assertEqual((await store.latest("cs101", "alice"))?.state, "resolved", "the resolved one");
        const second = await store.open(ask("cs101", "alice", "2026-01-05T10:00:00.000Z"));
        await store.open(ask("cs101", "bob", "2026-01-05T11:00:00.000Z"));
        await store.open(ask("cs102", "alice", "2026-01-05T12:00:00.000Z"));
        assertEqual((await store.latest("cs101", "alice"))?.id, second.id, "the newest in the course");
      }
    },
    {
      name: "a rating is written once: replace refuses a write over a rating made since the request was read",
      run: async () => {
        const store = await make();
        const r = await store.open(ask("cs101", "alice"));
        const resolved: HelpRequest = { ...r, state: "resolved", closed: { by: "ellen", at: "2026-01-05T09:05:00.000Z", reason: "resolved" } };
        assert(await store.replace(resolved, r), "resolved");
        assertEqual((await store.get(r.id))?.helped, null, "not rated yet");
        assert(await store.replace({ ...resolved, helped: true }, resolved), "rated");
        assertEqual(await store.replace({ ...resolved, helped: false }, resolved), false, "rated again from the same read");
        assertEqual((await store.get(r.id))?.helped, true, "the first rating kept");
      }
    },
    {
      name: "what is read back is a copy",
      run: async () => {
        const store = await make();
        const r = await store.open(ask("cs101", "alice"));
        const read = (await store.get(r.id))!;
        read.kind = "lecturer";
        assertEqual((await store.get(r.id))?.kind, "stuck", "stored kind");
      }
    }
  ];
}

const change = (courseId: string, id: string): AssistanceChange => ({ type: "help-request", courseId, request: { ...ask(courseId, "alice"), id } });

/** A watcher that notes, under `tag`, the id of each change it hears. */
const hearer = (heard: string[], tag: string) => (c: AssistanceChange) => heard.push(`${tag}:${c.type === "help-request" ? c.request.id : c.annotation.id}`);

export function assistanceFeedContract(make: Make<AssistanceFeed>): ContractCase[] {
  return [
    {
      name: "a published change reaches a watcher of its course only",
      run: async () => {
        const feed = await make();
        const heard: string[] = [];
        feed.watch("cs101", hearer(heard, "cs101"));
        feed.watch("cs102", hearer(heard, "cs102"));
        assert(await feed.publish(change("cs101", "h1")), "published");
        assertEqual(heard, ["cs101:h1"], "heard");
      }
    },
    {
      name: "a watcher that unsubscribed hears nothing more",
      run: async () => {
        const feed = await make();
        const heard: string[] = [];
        const stop = feed.watch("cs101", hearer(heard, "stopped"));
        feed.watch("cs101", hearer(heard, "watching"));
        stop();
        await feed.publish(change("cs101", "h1"));
        assertEqual(heard, ["watching:h1"], "heard");
      }
    },
    {
      name: "a change without a course is refused",
      run: async () => {
        const feed = await make();
        assertEqual(await feed.publish(change("", "h1")), false, "refused");
      }
    }
  ];
}

const annotation = (courseId: string, stepId: string, body = "Await the fetch."): Omit<Annotation, "id" | "revokedAt"> => ({
  anchor: { kind: "step", ref: step(courseId, stepId) },
  audience: { kind: "everyone" },
  body,
  authorId: "lecturer",
  createdAt: "2026-01-05T09:00:00.000Z"
});
const reflection = (learnerId: string): Omit<Reflection, "id"> => ({ ref: step("cs101"), learnerId, body: "Found it", kind: "discovery", sharedAt: "2026-01-05T09:00:00.000Z" });

export function feedbackStoreContract(make: Make<FeedbackStore>): ContractCase[] {
  return [
    {
      name: "an annotation reads back under its step, unrevoked, with an id",
      run: async () => {
        const store = await make();
        const kept = await store.annotate(annotation("cs101", "02"));
        assert(kept.id.length > 0, "id");
        assertEqual(kept.revokedAt, null, "revokedAt");
        assertEqual(
          (await store.forStep(step("cs101", "02"))).map((a) => [a.id, a.body, a.authorId]),
          [[kept.id, "Await the fetch.", "lecturer"]],
          "at the step"
        );
        assertEqual(await store.forStep(step("cs101", "03")), [], "another step");
      }
    },
    {
      name: "an annotation without an author or a body is rejected",
      run: async () => {
        const store = await make();
        let rejected = 0;
        for (const bad of [{ ...annotation("cs101", "02"), authorId: "" }, annotation("cs101", "02", "")]) await store.annotate(bad).catch(() => rejected++);
        assertEqual(rejected, 2, "rejected");
        assertEqual(await store.forStep(step("cs101", "02")), [], "nothing kept");
      }
    },
    {
      name: "reflections are kept per course and learner",
      run: async () => {
        const store = await make();
        const kept = await store.reflect(reflection("alice"));
        await store.reflect(reflection("bob"));
        assertEqual(
          (await store.reflections("cs101", "alice")).map((r) => r.id),
          [kept.id],
          "alice's"
        );
        assertEqual(await store.reflections("cs102", "alice"), [], "another course");
      }
    }
  ];
}

const note = (stepId: string, body = "Remember the await", courseId = "cs101"): Note => ({
  ref: step(courseId, stepId),
  body,
  kind: "note",
  updatedAt: "2026-01-05T09:00:00.000Z"
});

export function notesStoreContract(make: Make<NotesStore>): ContractCase[] {
  return [
    {
      name: "a step with no note reads null",
      run: async () => {
        const notes = await make();
        assertEqual(await notes.get(step("cs101")), null, "note");
        assertEqual(await notes.forCourse("cs101"), [], "course");
      }
    },
    {
      name: "a note is kept per step and the last write wins",
      run: async () => {
        const notes = await make();
        await notes.put(note("02", "first"));
        await notes.put(note("02", "second"));
        await notes.put(note("03", "other"));
        assertEqual((await notes.get(step("cs101", "02")))?.body, "second", "step 02");
        assertEqual((await notes.get(step("cs101", "03")))?.body, "other", "step 03");
      }
    },
    {
      name: "a course's notes are its own and a removed note is gone",
      run: async () => {
        const notes = await make();
        await notes.put(note("02"));
        await notes.put(note("03"));
        await notes.put(note("02", "elsewhere", "cs102"));
        await notes.remove(step("cs101", "03"));
        assertEqual(
          (await notes.forCourse("cs101")).map((n) => n.ref.stepId),
          ["02"],
          "cs101"
        );
        assertEqual(await notes.get(step("cs101", "03")), null, "removed");
      }
    }
  ];
}

export function insightsReadContract(
  make: (rows: { requests: HelpRequest[]; annotations: Annotation[]; reflections: Reflection[] }) => InsightsRead | Promise<InsightsRead>
): ContractCase[] {
  const inside = { ...ask("cs101", "alice", "2026-01-05T09:00:00.000Z"), id: "h1" };
  const before = { ...ask("cs101", "bob", "2026-01-04T23:59:59.000Z"), id: "h2" };
  const otherCourse = { ...ask("cs102", "carol", "2026-01-05T10:00:00.000Z"), id: "h3" };
  const period = { from: "2026-01-05T00:00:00.000Z", to: "2026-01-06T00:00:00.000Z" };
  return [
    {
      name: "reads only the course's rows inside the period",
      run: async () => {
        const read = await make({
          requests: [inside, before, otherCourse],
          annotations: [{ ...annotation("cs101", "02"), id: "a1", revokedAt: null }],
          reflections: [{ ...reflection("alice"), id: "r1" }]
        });
        assertEqual(
          (await read.helpRequests("cs101", period)).map((r) => r.id),
          ["h1"],
          "requests"
        );
        assertEqual(
          (await read.annotations("cs101", period)).map((a) => a.id),
          ["a1"],
          "annotations"
        );
        assertEqual(
          (await read.reflections("cs101", period)).map((r) => r.id),
          ["r1"],
          "reflections"
        );
      }
    }
  ];
}

/** Three desks over the same help requests: a student, the course's educator, and a visitor nobody signed in as. */
export type HelpDesks = { student: HelpDesk; educator: HelpDesk; visitor: HelpDesk };

/** What a desk answered: "ok", or the reason it refused. */
const outcome = (result: HelpDeskResult): string => (result.ok ? "ok" : result.reason);

/** The request a desk kept; a refusal fails the case. */
function kept(result: HelpDeskResult, what: string): HelpRequest {
  assert(result.ok, `${what}: refused as ${outcome(result)}`);
  return (result as Extract<HelpDeskResult, { ok: true }>).request;
}

/**
 * What every HelpDesk must do, as the students and lecturers of the course "cs101" ("alice" asks,
 * "ellen" is its educator): asks are kept as the person signed in, only an educator reads the
 * queue, a hint and the rating reach the request, and a visitor is refused.
 */
export function helpDeskContract(make: Make<HelpDesks>): ContractCase[] {
  return [
    {
      name: "a student's ask is theirs, and they read it back as their own request",
      run: async () => {
        const { student } = await make();
        const asked = kept(await student.ask(step("cs101"), "stuck"), "asked");
        const mine = await student.mine("cs101");
        assertEqual(mine && [mine.id, mine.kind, mine.state, mine.ref], [asked.id, "stuck", "open", step("cs101")], "mine");
        assertEqual(await student.mine("cs102"), null, "nothing in another course");
      }
    },
    {
      name: "only the course's educator reads the queue and acknowledges",
      run: async () => {
        const { student, educator } = await make();
        const asked = kept(await student.ask(step("cs101"), "lecturer"), "asked");
        assertEqual((await educator.queue("cs101")).map((r) => r.kind), ["lecturer"], "queue");
        let refused = false;
        await student.queue("cs101").catch(() => (refused = true));
        assert(refused, "a student may not read the queue");
        assertEqual(outcome(await student.act(asked.id, "acknowledge")), "not-permitted", "a student may not acknowledge");
        const acked = kept(await educator.act(asked.id, "acknowledge"), "acknowledged");
        assertEqual(acked.acknowledged?.by, "ellen", "acknowledged by the educator");
      }
    },
    {
      name: "a typed hint resolves the request, the student reads it and says once whether it helped",
      run: async () => {
        const { student, educator } = await make();
        const { id } = kept(await student.ask(step("cs101"), "hint"), "asked");
        assertEqual(outcome(await educator.answerHint(id, " ")), "hint-required", "an empty hint");
        kept(await educator.answerHint(id, "Check the loop bound."), "hinted");
        const mine = await student.mine("cs101");
        assertEqual(mine && [mine.state, mine.hintText, mine.helped], ["resolved", "Check the loop bound.", null], "the student reads the hint");
        assertEqual((await educator.queue("cs101")).length, 0, "gone from the queue");
        assertEqual(kept(await student.rate(id, true), "rated").helped, true, "rated");
        assertEqual(outcome(await student.rate(id, false)), "not-in-state-table", "rated once");
      }
    },
    {
      name: "the student withdraws their request, and it leaves the queue",
      run: async () => {
        const { student, educator } = await make();
        const asked = kept(await student.ask(step("cs101"), "stuck"), "asked");
        assertEqual(kept(await student.act(asked.id, "withdraw"), "withdrawn").state, "withdrawn", "withdrawn");
        assertEqual(await student.mine("cs101"), null, "nothing of theirs left");
        assertEqual(await educator.queue("cs101"), [], "queue empty");
      }
    },
    {
      name: "a visitor nobody signed in as is refused",
      run: async () => {
        const { visitor } = await make();
        assertEqual(outcome(await visitor.ask(step("cs101"), "stuck")), "signed-out", "ask refused");
        assertEqual(await visitor.mine("cs101"), null, "no request of theirs");
      }
    }
  ];
}
