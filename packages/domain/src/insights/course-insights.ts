/**
 * A course's insights over a chosen period, as Tutors Time shows them to its educators: the lab
 * steps ranked by how much help they needed (Rule 0412), the time to acknowledge and to resolve per
 * day and kind (Rule 0413), and the cohort they were computed over, whose size decides whether
 * percentiles are shown at all (Rule 0415). Pure arithmetic over stored rows; nothing here writes.
 */
import { HELP_KINDS, type HelpKind, type HelpRequest } from "../assistance/help-request.ts";
import type { Annotation } from "../feedback/annotation.ts";
import type { Reflection } from "../feedback/reflection.ts";
import { stepKey, type StepRef } from "../learning/step-ref.ts";
import { responseTimes, type ResponseTime, type ResponseTimes } from "./response-times.ts";
import { median, percentile } from "./statistics.ts";
import { waitSeconds } from "./step-diagnostic.ts";
import { cohortProfile, MIN_COHORT_FOR_PERCENTILES, type CohortProfile } from "./student-progress.ts";

/** How much help a step needed over the period. */
export type StepStruggle = {
  ref: StepRef;
  requests: Record<HelpKind, number>;
  /** Every request raised at the step, whatever its kind. */
  total: number;
  acknowledged: number;
  medianWaitSeconds: number | null;
  p90WaitSeconds: number | null;
  helpedByHint: number;
  annotations: number;
};

/** Time to acknowledge and to resolve on one UTC day, `YYYY-MM-DD`. */
export type DailyResponseTimes = { day: string; times: ResponseTimes };

export type CourseInsights = {
  cohort: CohortProfile;
  /** Hardest first: most requests, then the longest median wait. */
  steps: StepStruggle[];
  /** One entry per day that had a request, oldest first. */
  responseTimes: DailyResponseTimes[];
};

const dayOf = (iso: string) => iso.slice(0, 10);

/**
 * Whether a group of requests (one step, or one kind on one day) came from enough students for its
 * median and 90th percentile to be shown: with fewer, one student's own wait could be read off them,
 * however large the course's cohort (Rule 0571).
 */
const enoughStudents = (requests: readonly HelpRequest[]) => new Set(requests.map((r) => r.learnerId)).size >= MIN_COHORT_FOR_PERCENTILES;
const countsOnly = (t: ResponseTime): ResponseTime => ({ ...t, median: null, p90: null });

function struggleAt(ref: StepRef, requests: readonly HelpRequest[], annotations: number): StepStruggle {
  const waits = requests.map(waitSeconds).filter((w): w is number => w !== null);
  return {
    ref,
    requests: Object.fromEntries(HELP_KINDS.map((k) => [k, requests.filter((r) => r.kind === k).length])) as Record<HelpKind, number>,
    total: requests.length,
    acknowledged: requests.filter((r) => r.acknowledged !== null).length,
    medianWaitSeconds: median(waits),
    p90WaitSeconds: percentile(waits, 90),
    helpedByHint: requests.filter((r) => r.closed?.reason === "hint").length,
    annotations
  };
}

/**
 * Every step with a request or an unrevoked annotation in the rows, hardest first (Rule 0412): more
 * requests ranks higher, then a longer median wait (a step nobody waited at comes after one somebody
 * did), then the step's place in the course, so equal steps keep a stable order. A step whose
 * requests came from fewer than 5 students shows no median or 90th percentile (Rule 0571).
 */
export function rankSteps(requests: readonly HelpRequest[], annotations: readonly Annotation[]): StepStruggle[] {
  const steps = new Map<string, { ref: StepRef; requests: HelpRequest[]; annotations: number }>();
  const at = (ref: StepRef) => {
    const key = stepKey(ref);
    let step = steps.get(key);
    if (!step) steps.set(key, (step = { ref, requests: [], annotations: 0 }));
    return step;
  };
  for (const r of requests) at(r.ref).requests.push(r);
  for (const a of annotations) if (a.revokedAt === null) at(a.anchor.ref).annotations++;
  const order = (s: StepStruggle) => stepKey(s.ref);
  return [...steps.values()]
    .map((s) => ({ struggle: struggleAt(s.ref, s.requests, s.annotations), shown: enoughStudents(s.requests) }))
    .sort(
      ({ struggle: a }, { struggle: b }) =>
        b.total - a.total || (b.medianWaitSeconds ?? -1) - (a.medianWaitSeconds ?? -1) || order(a).localeCompare(order(b), undefined, { numeric: true })
    )
    .map(({ struggle, shown }) => (shown ? struggle : { ...struggle, medianWaitSeconds: null, p90WaitSeconds: null }));
}

/**
 * Time to acknowledge and to resolve per day the requests were raised, and per kind (Rule 0413); a
 * kind whose requests that day came from fewer than 5 students shows counts only (Rule 0571).
 */
export function dailyResponseTimes(requests: readonly HelpRequest[]): DailyResponseTimes[] {
  const days = new Map<string, HelpRequest[]>();
  for (const r of requests) {
    const day = dayOf(r.requestedAt);
    const rows = days.get(day);
    if (rows) rows.push(r);
    else days.set(day, [r]);
  }
  return [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, rows]) => {
      const times = responseTimes(rows);
      for (const kind of HELP_KINDS) {
        if (!enoughStudents(rows.filter((r) => r.kind === kind))) times[kind] = { acknowledge: countsOnly(times[kind].acknowledge), resolve: countsOnly(times[kind].resolve) };
      }
      return { day, times };
    });
}

/** The students with records in the period: those who asked for help or shared a reflection. */
export function cohortOf(courseId: string, requests: readonly HelpRequest[], reflections: readonly Reflection[]): CohortProfile {
  return cohortProfile(courseId, [...requests.map((r) => r.learnerId), ...reflections.map((r) => r.learnerId)]);
}

/** Counts stay; the median and the 90th percentile go, so no one student's wait can be read off a small cohort (Rule 0415). */
export function withholdPercentiles(insights: CourseInsights): CourseInsights {
  if (insights.cohort.percentilesShown) return insights;
  const times = (t: ResponseTimes): ResponseTimes =>
    Object.fromEntries(HELP_KINDS.map((k) => [k, { acknowledge: countsOnly(t[k].acknowledge), resolve: countsOnly(t[k].resolve) }])) as ResponseTimes;
  return {
    ...insights,
    steps: insights.steps.map((s) => ({ ...s, medianWaitSeconds: null, p90WaitSeconds: null })),
    responseTimes: insights.responseTimes.map((d) => ({ day: d.day, times: times(d.times) }))
  };
}

/** A course's insights from the rows of one period, percentiles withheld for a small cohort. */
export function courseInsights(courseId: string, requests: readonly HelpRequest[], annotations: readonly Annotation[], reflections: readonly Reflection[]): CourseInsights {
  return withholdPercentiles({
    cohort: cohortOf(courseId, requests, reflections),
    steps: rankSteps(requests, annotations),
    responseTimes: dailyResponseTimes(requests)
  });
}
