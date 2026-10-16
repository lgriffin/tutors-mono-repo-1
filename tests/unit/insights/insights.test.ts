/**
 * Insights' edges below the BDD features: the period arithmetic, the educator gate's refusals, the
 * in-memory desks, Tutors Time's insightsService (stale answers, a failing desk, the student page)
 * and how Time writes a duration and names a step. The features cover what an educator sees.
 */
import "../../bdd/support/svelte-runes-shim.ts";
import { afterEach, describe, expect, it } from "vitest";
import { openRequest, type HelpRequest } from "../../../packages/domain/src/assistance/index.ts";
import { courseInsights, rankSteps, withholdPercentiles } from "../../../packages/domain/src/insights/index.ts";
import { educatorInsights, insightsPeriod } from "../../../packages/application/src/index.ts";
import { InMemoryInsightsDesk, InMemoryInsightsRead, SignedOutInsightsDesk } from "../../../packages/application/src/testing/index.ts";
import type { InsightsAnswer, InsightsDesk } from "../../../packages/application/src/ports/index.ts";
import { anonymousAdapters, configureAdapters } from "../../../packages/adapters/driving/svelte-state/src/adapters.ts";
import { insightsService } from "../../../packages/adapters/driving/svelte-state/src/insights/insights.svelte.ts";
import { duration, REFUSAL_MESSAGES, stepName } from "../../../apps/time/src/lib/components/insights/format.ts";

const ref = (stepId: string) => ({ courseId: "cs101", labRoute: "/lab/cs101/lab-01", stepId });
const request = (learner: string, stepId: string, at: string, ackAfter: number | null): HelpRequest => ({
  ...openRequest(ref(stepId), { login: learner, name: null }, "stuck", at),
  id: `${learner}-${stepId}`,
  acknowledged: ackAfter === null ? null : { by: "ellen", at: new Date(Date.parse(at) + ackAfter * 1000).toISOString() }
});

afterEach(() => {
  insightsService.reset();
  configureAdapters(anonymousAdapters());
});

describe("insightsPeriod", () => {
  it("ends with the chosen day and reaches back 1, 7 or 30 days", () => {
    expect(insightsPeriod("day", "2026-03-01")).toEqual({ from: "2026-03-01T00:00:00.000Z", to: "2026-03-02T00:00:00.000Z" });
    expect(insightsPeriod("week", "2026-03-01")).toEqual({ from: "2026-02-23T00:00:00.000Z", to: "2026-03-02T00:00:00.000Z" });
    expect(insightsPeriod("month", "2026-03-01")?.from).toBe("2026-01-31T00:00:00.000Z");
  });

  it("is null for anything but a real calendar day and a known span", () => {
    for (const day of ["2026-02-30", "2026-13-01", "26-01-01", "", "2026-01-01T00:00"]) expect(insightsPeriod("day", day), day).toBeNull();
    expect(insightsPeriod("constructor" as never, "2026-01-01")).toBeNull();
  });
});

describe("educatorInsights", () => {
  const rows = [request("alice", "02", "2026-01-05T09:00:00.000Z", 60)];

  it("answers unavailable when the course's educators cannot be read, and invalid without a course or a learner", async () => {
    const read = new InMemoryInsightsRead(rows);
    const failing = educatorInsights({ insights: read, educatorsOf: async () => Promise.reject(new Error("course host down")) });
    expect(await failing.course("ellen", "cs101", "day", "2026-01-05")).toEqual({ ok: false, reason: "unavailable" });
    const insights = educatorInsights({ insights: read, educatorsOf: async () => ["ellen"] });
    expect(await insights.course("ellen", "", "day", "2026-01-05")).toEqual({ ok: false, reason: "invalid" });
    expect(await insights.student("ellen", "cs101", "", "day", "2026-01-05")).toEqual({ ok: false, reason: "invalid" });
    expect(read.reads).toBe(0);
  });

  it("answers not-ready without the views and unavailable when a read fails", async () => {
    const read = new InMemoryInsightsRead(rows);
    const insights = educatorInsights({ insights: read, educatorsOf: async () => ["ellen"] });
    read.failure = "not-ready";
    expect(await insights.course("ellen", "cs101", "day", "2026-01-05")).toEqual({ ok: false, reason: "not-ready" });
    read.failure = "unavailable";
    expect(await insights.student("ellen", "cs101", "alice", "day", "2026-01-05")).toEqual({ ok: false, reason: "unavailable" });
  });
});

describe("course insights in the domain", () => {
  it("counts an annotation's step even where nobody asked, and leaves a big cohort's percentiles alone", () => {
    const annotation = { id: "a1", anchor: { kind: "step" as const, ref: ref("09") }, audience: { kind: "everyone" as const }, body: "", authorId: "ellen", createdAt: "2026-01-05T10:00:00.000Z", revokedAt: null };
    expect(rankSteps([], [annotation]).map((s) => [s.ref.stepId, s.total, s.annotations])).toEqual([["09", 0, 1]]);
    const big = courseInsights("cs101", ["a", "b", "c", "d", "e"].map((l) => request(l, "02", "2026-01-05T09:00:00.000Z", 30)), [], []);
    expect(withholdPercentiles(big)).toBe(big);
  });

  it("puts a step nobody waited at after one somebody did", () => {
    const waited = request("alice", "05", "2026-01-05T09:00:00.000Z", 30);
    const waiting = request("bob", "02", "2026-01-05T09:00:00.000Z", null);
    expect(rankSteps([waiting, waited], []).map((s) => s.ref.stepId)).toEqual(["05", "02"]);
  });
});

describe("the in-memory insights desks", () => {
  it("refuses everything when nobody is signed in", async () => {
    for (const desk of [new SignedOutInsightsDesk(), new InMemoryInsightsDesk()]) {
      expect(await desk.course("cs101", "day", "2026-01-05")).toEqual({ ok: false, reason: "signed-out" });
      expect(await desk.student("cs101", "alice", "day", "2026-01-05")).toEqual({ ok: false, reason: "signed-out" });
    }
  });
});

describe("insightsService", () => {
  const desk = new InMemoryInsightsDesk({ read: new InMemoryInsightsRead([request("alice", "02", "2026-01-05T09:00:00.000Z", 60)]), educators: { cs101: ["ellen"] }, actor: "ellen" });

  it("reads nothing until a page is open, and ends the span on today until a day is chosen", async () => {
    configureAdapters({ ...anonymousAdapters(), anonymous: false, insightsDesk: desk });
    await insightsService.choose("day");
    expect(insightsService.course.value).toEqual({ loading: false, answer: null });
    expect(insightsService.endingDay()).toBe(new Date().toISOString().slice(0, 10));
    await insightsService.choose("day", "2026-01-05");
    expect(insightsService.endingDay()).toBe("2026-01-05");
    await insightsService.openStudent("cs101", "alice");
    const answer = insightsService.student.value.answer;
    expect(answer?.ok && answer.value.requestsRaised).toBe(1);
  });

  it("keeps the newest answer, drops one that lands after the page closed, and answers unavailable for a desk that throws", async () => {
    let release: (answer: InsightsAnswer<never>) => void = () => {};
    const slow: InsightsDesk = {
      course: () => new Promise((resolve) => (release = resolve)),
      student: async () => Promise.reject(new Error("offline"))
    };
    configureAdapters({ ...anonymousAdapters(), anonymous: false, insightsDesk: slow });
    const first = insightsService.openCourse("cs101");
    expect(insightsService.course.value.loading).toBe(true);
    insightsService.close();
    release({ ok: false, reason: "forbidden" });
    await first;
    expect(insightsService.course.value).toEqual({ loading: true, answer: null });
    await insightsService.openStudent("cs101", "alice");
    expect(insightsService.student.value).toEqual({ loading: false, answer: { ok: false, reason: "unavailable" } });
    configureAdapters({ ...anonymousAdapters(), anonymous: false, insightsDesk: { ...slow, course: async () => Promise.reject(new Error("offline")) } });
    await insightsService.openCourse("cs101");
    expect(insightsService.course.value.answer).toEqual({ ok: false, reason: "unavailable" });
  });
});

describe("Time's insights formatting", () => {
  const units = { seconds: "s", minutes: "min" };

  it("writes seconds under two minutes, minutes to one decimal above, and a dash for none", () => {
    expect([duration(null, units), duration(45, units), duration(119, units), duration(210, units), duration(3600, units)]).toEqual(["–", "45 s", "119 s", "3.5 min", "60 min"]);
  });

  it("names a step by its lab's last segment, and has a message for every refusal", () => {
    expect(stepName("/lab/cs101/topic-01/lab-02", "03")).toBe("lab-02 / 03");
    expect(stepName("", "03")).toBe(" / 03");
    expect(Object.keys(REFUSAL_MESSAGES).sort()).toEqual(["forbidden", "invalid", "not-kept", "not-ready", "signed-out", "unavailable"]);
  });
});
