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
import type { FeedbackDesk, FeedbackDeskResult, ReflectionDeskResult } from "../ports/feedback-desk.ts";
import type { HelpDesk, HelpDeskResult } from "../ports/help-desk.ts";
import type { InsightsAnswer, InsightsDesk } from "../ports/insights-desk.ts";
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
        assertEqual((await store.reflectionsAt(step("cs101"))).map((r) => r.learnerId).sort(), ["alice", "bob"], "at the step");
        assertEqual(await store.reflectionsAt(step("cs102")), [], "at a step of another course");
      }
    },
    {
      name: "an annotation reads back by id, and an unknown id reads null",
      run: async () => {
        const store = await make();
        const kept = await store.annotate(annotation("cs101", "02"));
        assertEqual((await store.get(kept.id))?.body, "Await the fetch.", "by id");
        assertEqual(await store.get("00000000-0000-4000-8000-000000000000"), null, "unknown");
        assertEqual(await store.get("not-an-id"), null, "malformed");
      }
    },
    {
      name: "a revoked annotation is kept with its first revocation time",
      run: async () => {
        const store = await make();
        const kept = await store.annotate(annotation("cs101", "02"));
        const revoked = await store.revoke(kept.id, "2026-01-05T10:00:00.000Z");
        assertEqual(revoked?.revokedAt, "2026-01-05T10:00:00.000Z", "revoked");
        assertEqual((await store.revoke(kept.id, "2026-01-05T11:00:00.000Z"))?.revokedAt, "2026-01-05T10:00:00.000Z", "first time kept");
        assertEqual(
          (await store.forStep(step("cs101", "02"))).map((a) => [a.id, a.revokedAt]),
          [[kept.id, "2026-01-05T10:00:00.000Z"]],
          "still at the step"
        );
        assertEqual(await store.revoke("00000000-0000-4000-8000-000000000000", "2026-01-05T10:00:00.000Z"), null, "unknown");
      }
    },
    {
      name: "a learner receives broadcasts and their own annotations, unrevoked, newest first",
      run: async () => {
        const store = await make();
        const first = await store.annotate(annotation("cs101", "02", "First"));
        const mine = await store.annotate({ ...annotation("cs101", "03", "For alice"), audience: { kind: "student", learnerId: "alice" }, createdAt: "2026-01-05T09:05:00.000Z" });
        await store.annotate({ ...annotation("cs101", "03", "For bob"), audience: { kind: "student", learnerId: "bob" }, createdAt: "2026-01-05T09:06:00.000Z" });
        const gone = await store.annotate({ ...annotation("cs101", "04", "Revoked"), createdAt: "2026-01-05T09:07:00.000Z" });
        await store.revoke(gone.id, "2026-01-05T09:08:00.000Z");
        await store.annotate(annotation("cs102", "02", "Another course"));
        assertEqual(
          (await store.received("cs101", "alice")).map((a) => a.id),
          [mine.id, first.id],
          "alice's, newest first"
        );
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
    },
    {
      name: "the period is half-open: a row at its start is read, one at its end is not",
      run: async () => {
        const read = await make({
          requests: [
            { ...ask("cs101", "alice", period.from), id: "h1" },
            { ...ask("cs101", "bob", period.to), id: "h2" }
          ],
          annotations: [
            { ...annotation("cs101", "02"), id: "a1", createdAt: period.from, revokedAt: null },
            { ...annotation("cs101", "02"), id: "a2", createdAt: period.to, revokedAt: null }
          ],
          reflections: [
            { ...reflection("alice"), id: "r1", sharedAt: period.from },
            { ...reflection("bob"), id: "r2", sharedAt: period.to }
          ]
        });
        assertEqual((await read.helpRequests("cs101", period)).map((r) => r.id), ["h1"], "requests");
        assertEqual((await read.annotations("cs101", period)).map((a) => a.id), ["a1"], "annotations");
        assertEqual((await read.reflections("cs101", period)).map((r) => r.id), ["r1"], "reflections");
      }
    },
    {
      name: "a request reads back with what the numbers are made of: kind, step, learner, acknowledgement and closure",
      run: async () => {
        const answered: HelpRequest = {
          ...ask("cs101", "alice", "2026-01-05T09:00:00.000Z"),
          id: "h1",
          kind: "hint",
          state: "resolved",
          acknowledged: { by: "ellen", at: "2026-01-05T09:01:00.000Z" },
          closed: { by: "ellen", at: "2026-01-05T09:03:00.000Z", reason: "hint" },
          helped: true
        };
        const revoked = { ...annotation("cs101", "03"), id: "a1", revokedAt: "2026-01-05T11:00:00.000Z" };
        const read = await make({ requests: [answered], annotations: [revoked], reflections: [] });
        const [r] = await read.helpRequests("cs101", period);
        assertEqual(
          r && [r.ref, r.learnerId, r.kind, r.state, r.requestedAt, r.acknowledged, r.closed, r.helped],
          [answered.ref, "alice", "hint", "resolved", answered.requestedAt, answered.acknowledged, answered.closed, true],
          "request"
        );
        const [a] = await read.annotations("cs101", period);
        assertEqual(a && [a.anchor.ref, a.audience, a.revokedAt], [revoked.anchor.ref, revoked.audience, revoked.revokedAt], "a revoked annotation is read too");
      }
    }
  ];
}

/** Three desks over the same rows: the course's educator, a student, and a visitor nobody signed in as. */
export type InsightsDesks = { educator: InsightsDesk; student: InsightsDesk; visitor: InsightsDesk };

/**
 * What every InsightsDesk must do over the stored rows of the course "cs101", whose educator is
 * "ellen": only she reads its insights, for a bounded span ending with a real day, ranked and
 * withheld as the domain says; a student and a visitor are refused.
 */
export function insightsDeskContract(make: (rows: { requests: HelpRequest[]; annotations: Annotation[]; reflections: Reflection[] }) => InsightsDesks | Promise<InsightsDesks>): ContractCase[] {
  const at = (learner: string, stepId: string, time: string, ackSeconds: number | null): HelpRequest => ({
    ...openRequest(step("cs101", stepId), { login: learner, name: null }, "stuck", time),
    id: `${learner}-${stepId}-${time}`,
    state: ackSeconds === null ? "open" : "acknowledged",
    acknowledged: ackSeconds === null ? null : { by: "ellen", at: new Date(Date.parse(time) + ackSeconds * 1000).toISOString() }
  });
  const learners = ["alice", "bob", "carol", "dan", "erin"];
  const busy = learners.map((l, i) => at(l, "03", `2026-01-05T09:0${i}:00.000Z`, 60 * (i + 1)));
  const quiet = [at("alice", "02", "2026-01-05T10:00:00.000Z", 30)];
  const lastWeek = [at("frank", "04", "2025-12-30T09:00:00.000Z", 10)];
  const rows = { requests: [...busy, ...quiet, ...lastWeek], annotations: [], reflections: [{ ...reflection("alice"), id: "r1", sharedAt: "2026-01-05T11:00:00.000Z" }] };
  const value = <T>(answer: InsightsAnswer<T>, what: string): T => {
    assert(answer.ok, `${what}: refused as ${answer.ok ? "" : answer.reason}`);
    return (answer as Extract<InsightsAnswer<T>, { ok: true }>).value;
  };
  const refusal = (answer: InsightsAnswer<unknown>) => (answer.ok ? "ok" : answer.reason);
  return [
    {
      name: "an educator reads the course's steps hardest first over the day, with its cohort and response times; a one-student step shows counts only",
      run: async () => {
        const { educator } = await make(rows);
        const answer = await educator.course("cs101", "day", "2026-01-05");
        const insights = value(answer, "day");
        assertEqual(answer.ok && answer.period, { from: "2026-01-05T00:00:00.000Z", to: "2026-01-06T00:00:00.000Z" }, "the day");
        assertEqual(
          insights.steps.map((s) => [s.ref.stepId, s.total, s.medianWaitSeconds, s.p90WaitSeconds]),
          [
            ["03", 5, 180, 300],
            ["02", 1, null, null]
          ],
          "ranked"
        );
        assertEqual([insights.cohort.students, insights.cohort.percentilesShown], [5, true], "cohort");
        assertEqual(
          insights.responseTimes.map((d) => [d.day, d.times.stuck.acknowledge.count, d.times.stuck.acknowledge.median]),
          [["2026-01-05", 6, 120]],
          "response times"
        );
      }
    },
    {
      name: "a week reaches back seven days, and a small cohort's percentiles are withheld",
      run: async () => {
        const { educator } = await make({ ...rows, requests: [...quiet, ...lastWeek] });
        const week = value(await educator.course("cs101", "week", "2026-01-05"), "week");
        assertEqual(week.steps.map((s) => [s.ref.stepId, s.total, s.medianWaitSeconds]), [["02", 1, null], ["04", 1, null]], "counts, no percentiles");
        assertEqual(week.cohort.percentilesShown, false, "withheld");
        const day = value(await educator.course("cs101", "day", "2026-01-05"), "day");
        assertEqual(day.steps.map((s) => s.ref.stepId), ["02"], "the day alone");
      }
    },
    {
      name: "an educator reads one student's requests, hints, annotations and reflections",
      run: async () => {
        const { educator } = await make(rows);
        const alice = value(await educator.student("cs101", "alice", "month", "2026-01-05"), "alice");
        assertEqual([alice.learnerId, alice.requestsRaised, alice.hintsRead, alice.reflectionsShared], ["alice", 2, 0, 1], "alice");
      }
    },
    {
      name: "a student and a visitor are refused, and an ask with no real day is invalid",
      run: async () => {
        const { educator, student, visitor } = await make(rows);
        assertEqual(refusal(await student.course("cs101", "day", "2026-01-05")), "forbidden", "a student");
        assertEqual(refusal(await student.student("cs101", "alice", "day", "2026-01-05")), "forbidden", "even about themselves");
        assertEqual(refusal(await visitor.course("cs101", "day", "2026-01-05")), "signed-out", "a visitor");
        assertEqual(refusal(await educator.course("cs101", "day", "2026-02-30")), "invalid", "no such day");
        assertEqual(refusal(await educator.course("cs102", "day", "2026-01-05")), "forbidden", "another course");
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
        assertEqual(
          (await educator.queue("cs101")).map((r) => r.kind),
          ["lecturer"],
          "queue"
        );
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

/** Desks over the same feedback, signed in as a student (alice), another student (bob), the course's educator (ellen) and nobody. */
export type FeedbackDesks = { student: FeedbackDesk; other: FeedbackDesk; educator: FeedbackDesk; visitor: FeedbackDesk };

const feedbackOutcome = (result: FeedbackDeskResult | ReflectionDeskResult): string => (result.ok ? "ok" : result.reason);

function posted(result: FeedbackDeskResult, what: string): Annotation {
  assert(result.ok, `${what}: refused as ${feedbackOutcome(result)}`);
  return (result as Extract<FeedbackDeskResult, { ok: true }>).annotation;
}

export function feedbackDeskContract(make: Make<FeedbackDesks>): ContractCase[] {
  return [
    {
      name: "an educator's broadcast shows to every signed-in student on the step, and only an educator may post one",
      run: async () => {
        const { student, other, educator, visitor } = await make();
        const kept = posted(await educator.broadcast(step("cs101"), "Await the fetch.", "Fetching"), "broadcast");
        assertEqual([kept.audience.kind, kept.authorId, kept.body], ["everyone", "ellen", "Await the fetch."], "kept");
        for (const desk of [student, other])
          assertEqual(
            (await desk.step(step("cs101"))).broadcasts.map((a) => a.id),
            [kept.id],
            "a student sees it"
          );
        assertEqual(await visitor.step(step("cs101")), { broadcasts: [], personal: [], history: null }, "a visitor sees nothing");
        assertEqual((await student.step(step("cs101", "03"))).broadcasts, [], "another step");
        assertEqual(feedbackOutcome(await student.broadcast(step("cs101"), "Me too")), "forbidden", "a student may not broadcast");
        assertEqual(feedbackOutcome(await visitor.broadcast(step("cs101"), "Me too")), "signed-out", "nor a visitor");
        assertEqual(feedbackOutcome(await educator.broadcast(step("cs101"), "  ")), "invalid", "an empty explanation");
      }
    },
    {
      name: "an annotation for one student shows to that student only",
      run: async () => {
        const { student, other, educator } = await make();
        const kept = posted(await educator.annotate({ ref: step("cs101") }, { learnerId: "alice" }, "Nearly there."), "annotated");
        assertEqual(
          (await student.step(step("cs101"))).personal.map((a) => a.id),
          [kept.id],
          "alice sees it"
        );
        assertEqual((await other.step(step("cs101"))).personal, [], "bob does not");
        assertEqual(feedbackOutcome(await educator.annotate({ ref: step("cs101") }, {}, "Nobody")), "invalid", "no audience");
      }
    },
    {
      name: "a revoked annotation stops showing to students and stays in the educator's history",
      run: async () => {
        const { student, educator } = await make();
        const kept = posted(await educator.broadcast(step("cs101"), "Await the fetch."), "broadcast");
        assertEqual(feedbackOutcome(await student.revoke(kept.id)), "forbidden", "a student may not revoke");
        const revoked = posted(await educator.revoke(kept.id), "revoked");
        assert(revoked.revokedAt !== null, "revoked");
        assertEqual((await student.step(step("cs101"))).broadcasts, [], "gone for the student");
        const history = (await educator.step(step("cs101"))).history;
        assertEqual(
          history?.annotations.map((a) => [a.id, a.revokedAt]),
          [[kept.id, revoked.revokedAt]],
          "kept in the history"
        );
        assertEqual(feedbackOutcome(await educator.revoke("00000000-0000-4000-8000-000000000000")), "not-found", "unknown");
      }
    },
    {
      name: "a student reads what they received in the course, and an educator's step has no history for a student",
      run: async () => {
        const { student, other, educator } = await make();
        const everyone = posted(await educator.broadcast(step("cs101"), "For everyone"), "broadcast");
        const alice = posted(await educator.annotate({ ref: step("cs101", "03") }, { learnerId: "alice" }, "For alice"), "annotated");
        posted(await educator.annotate({ ref: step("cs101", "03") }, { learnerId: "bob" }, "For bob"), "annotated");
        assertEqual((await student.received("cs101")).map((a) => a.id).sort(), [everyone.id, alice.id].sort(), "alice's");
        assertEqual((await other.received("cs101")).length, 2, "bob's");
        assertEqual((await student.step(step("cs101"))).history, null, "no history for a student");
      }
    },
    {
      name: "a shared note reaches the step's history as a reflection, and the educator replies to that student",
      run: async () => {
        const { student, other, educator } = await make();
        const note: Note = { ref: step("cs101"), body: "The loop ran once too many.", kind: "discovery", updatedAt: "2026-01-05T09:00:00.000Z" };
        assertEqual(feedbackOutcome(await student.reflect({ ...note, body: " " })), "no-note", "an empty note");
        const shared = await student.reflect(note);
        assert(shared.ok, "shared");
        const reflection = (shared as Extract<ReflectionDeskResult, { ok: true }>).reflection;
        assertEqual([reflection.learnerId, reflection.body, reflection.kind], ["alice", note.body, "discovery"], "the copy");
        const history = (await educator.step(step("cs101"))).history;
        assertEqual(
          history?.reflections.map((r) => r.id),
          [reflection.id],
          "in the step's history"
        );
        const reply = posted(await educator.annotate({ ref: step("cs101"), reflectionId: reflection.id }, { learnerId: "alice" }, "Good catch."), "replied");
        assertEqual(reply.anchor, { kind: "reflection", ref: step("cs101"), reflectionId: reflection.id }, "anchored to the reflection");
        assertEqual(
          (await student.step(step("cs101"))).personal.map((a) => a.id),
          [reply.id],
          "alice reads the reply"
        );
        assertEqual((await other.step(step("cs101"))).personal, [], "bob does not");
      }
    }
  ];
}
