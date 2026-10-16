/**
 * Learning insights (Rules 0410 to 0415, 0418, 0419): the Insights use cases over the in-memory read
 * port, and Tutors Time's insightsService over the in-memory insights desk, which runs the same use
 * cases as the educator signed in.
 */
import "../../support/svelte-runes-shim.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { t } from "../../../../packages/adapters/driving/i18n/src/index.ts";
import type { Reflection } from "@tutors/domain/feedback";
import type { CourseInsights } from "@tutors/domain/insights";
import { openRequest, type HelpKind, type HelpRequest } from "@tutors/domain/assistance";
import type { Annotation } from "@tutors/domain/feedback";
import type { StepDiagnostic } from "@tutors/domain/insights";
import type { StepRef } from "@tutors/domain/learning";
import { stepDiagnostics } from "../../../../packages/application/src/index.ts";
import { InMemoryInsightsDesk, InMemoryInsightsRead } from "../../../../packages/application/src/testing/index.ts";
import { anonymousAdapters, configureAdapters } from "../../../../packages/adapters/driving/svelte-state/src/adapters.ts";
import { insightsService } from "../../../../packages/adapters/driving/svelte-state/src/insights/insights.svelte.ts";

const feature = await loadFeature("tests/bdd/features/instructor/learning-insights.feature");

type Row = { learner: string; kind: string; requested: string; acknowledged: string; closed: string; reason: string };

const ROOT = join(import.meta.dirname, "../../../..");

describeFeature(feature, ({ Background, Rule, AfterEachScenario }) => {
  let courseId: string;
  let labRoute: string;
  let requests: HelpRequest[];
  let annotations: Annotation[];
  let read: InMemoryInsightsRead;
  let snapshot: string;
  let diagnostics: StepDiagnostic[];

  const at = (stepId: string): StepRef => ({ courseId, labRoute, stepId });
  let nextId = 1;
  const request = (stepId: string, learner: string, kind: HelpKind, requestedAt: string, acknowledged?: string, closed?: string, reason?: string): HelpRequest => ({
    ...openRequest(at(stepId), { login: learner, name: null }, kind, requestedAt),
    id: `h${nextId++}`,
    state: closed ? (reason === "withdrawn" ? "withdrawn" : "resolved") : acknowledged ? "acknowledged" : "open",
    acknowledged: acknowledged ? { by: "ellen", at: acknowledged } : null,
    closed: closed ? { by: "ellen", at: closed, reason: (reason || "resolved") as "resolved" } : null
  });

  Background(({ Given }) => {
    Given("the course {string} with the lab {string}", (_ctx, course: string, lab: string) => {
      courseId = course;
      labRoute = lab;
      requests = [];
      annotations = [];
      reflections = [];
    });
  });

  AfterEachScenario(() => {
    insightsService.reset();
    configureAdapters(anonymousAdapters());
  });

  // Tutors Time's insights pages, through its service over the in-memory desk.
  let reflections: Reflection[] = [];
  let lecturer = "";
  const plus = (iso: string, seconds: number) => new Date(Date.parse(iso) + seconds * 1000).toISOString();
  const asked = (learner: string, stepId: string, day: string, minute: number, ackSeconds: number) => {
    const requestedAt = `${day}T09:${String(minute).padStart(2, "0")}:00.000Z`;
    requests.push(request(stepId, learner, "stuck", requestedAt, plus(requestedAt, ackSeconds)));
  };
  const openAs = (login: string, span: "day" | "week" | "month", day: string, learnerId?: string) => {
    const desk = new InMemoryInsightsDesk({ read: new InMemoryInsightsRead(requests, annotations, reflections), educators: { [courseId]: [lecturer] } });
    configureAdapters({ ...anonymousAdapters(), anonymous: false, insightsDesk: desk.as(login) });
    insightsService.reset();
    void insightsService.choose(span, day);
    return learnerId ? insightsService.openStudent(courseId, learnerId) : insightsService.openCourse(courseId);
  };
  const shown = (): CourseInsights => {
    const answer = insightsService.course.value.answer;
    expect(answer?.ok, JSON.stringify(answer)).toBe(true);
    return (answer as { ok: true; value: CourseInsights }).value;
  };
  const step = (stepId: string) => shown().steps.find((s) => s.ref.stepId === stepId)!;
  const span = (days: number) => (days === 7 ? "week" : "month");

  const teaches = (_ctx: unknown, login: string) => {
    lecturer = login;
  };
  const many = (_ctx: unknown, count: number, stepId: string, day: string) => {
    for (let i = 0; i < count; i++) asked(`student-${i + 1}`, stepId, day, i, 60 * (i + 1));
  };
  const one = (_ctx: unknown, learner: string, stepId: string, day: string, seconds: number) => asked(learner, stepId, day, 30, seconds);
  const oneMinutes = (_ctx: unknown, learner: string, stepId: string, day: string, minutes: number) => asked(learner, stepId, day, 30, minutes * 60);
  const hinted = (_ctx: unknown, learner: string, stepId: string, day: string, minutes: number) => {
    const requestedAt = `${day}T11:00:00.000Z`;
    requests.push(request(stepId, learner, "hint", requestedAt, undefined, plus(requestedAt, minutes * 60), "hint"));
  };
  const opensDay = (_ctx: unknown, login: string, day: string) => openAs(login, "day", day);
  const opensSpan = (_ctx: unknown, login: string, days: number, day: string) => openAs(login, span(days), day);
  const ranked = (_ctx: unknown, order: string) => expect(shown().steps.map((s) => s.ref.stepId)).toEqual(order.split(", "));
  const withMedian = (_ctx: unknown, stepId: string, total: number, median: number) => expect([step(stepId).total, step(stepId).medianWaitSeconds]).toEqual([total, median]);
  const saysCountsOnly = (yes: boolean) => () => {
    expect(shown().cohort.percentilesShown).toBe(!yes);
    expect(t("insights.withheld")).toMatch(/only counts/);
  };

  const stored = (_ctx: unknown, day: string, stepId: string, rows: Row[]) => {
    const t = (time: string) => (time ? `${day}T${time}.000Z` : undefined);
    for (const r of rows) requests.push(request(stepId, r.learner, r.kind as HelpKind, t(r.requested)!, t(r.acknowledged), t(r.closed), r.reason));
  };
  const compute = async (_ctx: unknown, day: string) => {
    read = new InMemoryInsightsRead(requests, annotations);
    snapshot = JSON.stringify({ requests, annotations });
    diagnostics = await stepDiagnostics({ insights: read })(courseId, day);
  };

  Rule("Tutors shall compute insights only from stored learning, assistance and feedback records through one read port, never writing.", ({ RuleScenario }) => {
    RuleScenario("Insights read through the read port and leave the records as they were", ({ Given, When, Then, And }) => {
      Given("the stored help requests of {string} at the step {string}", stored);
      When("tutors computes the diagnostics of {string}", async (ctx, day: string) => {
        await compute(ctx, day);
      });
      Then("tutors shall have read the records through the insights read port", () => {
        expect(read.reads).toBeGreaterThan(0);
        expect(diagnostics.map((d) => d.requests.hint)).toEqual([1]);
        const writers = Object.getOwnPropertyNames(Object.getPrototypeOf(read)).filter((m) => m !== "constructor" && !["helpRequests", "annotations", "reflections"].includes(m));
        expect(writers).toEqual([]);
      });
      And("the stored records shall be unchanged", () => {
        expect(JSON.stringify({ requests, annotations })).toBe(snapshot);
      });
    });
  });

  Rule(
    "Tutors shall compute a step diagnostic as requests by kind, acknowledged count, median and 90th percentile waiting seconds, helped answers and annotations for a step and day.",
    ({ RuleScenario }) => {
      RuleScenario("A step's day in numbers", ({ Given, And, When, Then }) => {
        let diagnostic: StepDiagnostic;
        Given("the stored help requests of {string} at the step {string}", stored);
        And("a stored help request by {string} of kind {string} on {string} at the step {string}", (_ctx, learner: string, kind: HelpKind, day: string, stepId: string) => {
          requests.push(request(stepId, learner, kind, `${day}T09:00:00.000Z`));
        });
        And("{number} stored annotations at the step {string} on {string}", (_ctx, count: number, stepId: string, day: string) => {
          for (let i = 0; i < count; i++)
            annotations.push({
              id: `a${i}`,
              anchor: { kind: "step", ref: at(stepId) },
              audience: { kind: "everyone" },
              body: "Await it.",
              authorId: "ellen",
              createdAt: `${day}T10:0${i}:00.000Z`,
              revokedAt: null
            });
        });
        When("tutors computes the diagnostics of {string}", compute);
        Then(
          "the diagnostic of the step {string} shall count {number} {string}, {number} {string} and {number} {string} requests",
          (_ctx, stepId: string, a: number, ka: string, b: number, kb: string, c: number, kc: string) => {
            diagnostic = diagnostics.find((d) => d.ref.stepId === stepId)!;
            expect(diagnostic.requests).toEqual({ [ka]: a, [kb]: b, [kc]: c });
          }
        );
        And("the diagnostic shall count {number} acknowledged", (_ctx, count: number) => expect(diagnostic.acknowledged).toBe(count));
        And("the diagnostic's median wait shall be {number} seconds and its 90th percentile wait {number} seconds", (_ctx, median: number, p90: number) => {
          expect([diagnostic.medianWaitSeconds, diagnostic.p90WaitSeconds]).toEqual([median, p90]);
        });
        And("the diagnostic shall count {number} helped by a hint and {number} annotations", (_ctx, hints: number, count: number) => {
          expect([diagnostic.helpedByHint, diagnostic.annotations]).toEqual([hints, count]);
        });
      });
    }
  );

  Rule(
    "When an educator opens a course's insights, tutors shall rank its lab steps by requests and waiting time for the chosen day, week or month.",
    ({ RuleScenario }) => {
      RuleScenario("The step most students asked about comes first, and the week reaches further back than the day", ({ Given, And, When, Then }) => {
        Given("{string} teaches the course", teaches);
        And("{number} students each asked for help at the step {string} on {string}, acknowledged after 1 to 5 minutes", many);
        And("{string} asked for help at the step {string} on {string}, acknowledged after {number} seconds", one);
        And("{string} asked for help at the step {string} on {string}, acknowledged after {number} minutes", oneMinutes);
        When("{string} opens the course's insights for the day {string}", opensDay);
        Then("the steps shall be ranked {string}", ranked);
        And("the step {string} shall show {number} requests with a median wait of {number} seconds", withMedian);
        When("{string} chooses 7 days", () => insightsService.choose("week"));
        Then("the steps over the 7 days shall be ranked {string}", ranked);
      });

      RuleScenario("Equal requests rank the longer wait first", ({ Given, And, When, Then }) => {
        Given("{string} teaches the course", teaches);
        And("these students asked for help on {string}", (_ctx, day: string, rows: { learner: string; step: string; waited: string }[]) => {
          for (const r of rows) asked(r.learner, r.step, day, 30, Number(r.waited));
        });
        When("{string} opens the course's insights for the day {string}", opensDay);
        Then("the steps shall be ranked {string}", ranked);
      });

      RuleScenario("A student cannot open the course's insights", ({ Given, And, When, Then }) => {
        Given("{string} teaches the course", teaches);
        And("{string} asked for help at the step {string} on {string}, acknowledged after {number} seconds", one);
        When("{string} opens the course's insights for the day {string}", opensDay);
        Then("the insights page shall say {string} and rank no step", (_ctx, reason: string) => {
          expect(insightsService.course.value.answer).toEqual({ ok: false, reason });
        });
      });
    }
  );

  Rule("Tutors shall report time to acknowledge and time to resolve as median and 90th percentile per day and per kind of help.", ({ RuleScenario }) => {
    RuleScenario("Each day and kind has its own times", ({ Given, And, When, Then }) => {
      Given("{string} teaches the course", teaches);
      And("{number} students each asked for help at the step {string} on {string}, acknowledged after 1 to 5 minutes", many);
      And("{string} asked for a hint at the step {string} on {string}, answered with a hint after {number} minutes", hinted);
      When("{string} opens the course's insights for {number} days ending {string}", opensSpan);
      const timesOf = (day: string) => shown().responseTimes.find((d) => d.day === day)!.times;
      Then(
        "the response times of {string} for {string} shall be {number} resolved with a median of {number} seconds and a 90th percentile of {number} seconds",
        (_ctx, day: string, kind: HelpKind, count: number, median: number, p90: number) => {
          expect(timesOf(day)[kind].resolve).toEqual({ count, median, p90 });
        }
      );
      And(
        "the response times of {string} for {string} shall be {number} acknowledged with a median of {number} seconds and a 90th percentile of {number} seconds",
        (_ctx, day: string, kind: HelpKind, count: number, median: number, p90: number) => {
          expect(timesOf(day)[kind].acknowledge).toEqual({ count, median, p90 });
        }
      );
      And("the response times of {string} shall have none for {string}", (_ctx, day: string, kind: HelpKind) => {
        expect(timesOf(day)[kind]).toEqual({ acknowledge: { count: 0, median: null, p90: null }, resolve: { count: 0, median: null, p90: null } });
      });
    });
  });

  Rule(
    "Tutors shall show on a student's page their requests raised, hints read, annotations received and reflections shared beside the existing calendar and lab analytics.",
    ({ RuleScenario }) => {
      RuleScenario("A student's part in the course", ({ Given, And, When, Then }) => {
        Given("{string} teaches the course", teaches);
        And("{string} asked for a hint at the step {string} on {string}, answered with a hint after {number} minutes", hinted);
        And("{string} asked for help at the step {string} on {string}, acknowledged after {number} seconds", one);
        And("{string} wrote an annotation to {string} at the step {string} on {string}", (_ctx, author: string, learnerId: string, stepId: string, day: string) => {
          annotations.push({ id: `a${annotations.length}`, anchor: { kind: "step", ref: at(stepId) }, audience: { kind: "student", learnerId }, body: "Nearly.", authorId: author, createdAt: `${day}T12:00:00.000Z`, revokedAt: null });
        });
        And("{string} shared a reflection at the step {string} on {string}", (_ctx, learnerId: string, stepId: string, day: string) => {
          reflections.push({ id: `r${reflections.length}`, ref: at(stepId), learnerId, body: "Found it.", kind: "reflection", sharedAt: `${day}T13:00:00.000Z` });
        });
        When("{string} opens the student page of {string} for {number} days ending {string}", (_ctx, login: string, learnerId: string, days: number, day: string) =>
          openAs(login, span(days), day, learnerId)
        );
        Then(
          "the page shall show {number} requests raised, {number} hint read, {number} annotation received and {number} reflection shared",
          (_ctx, raised: number, hints: number, received: number, shared: number) => {
            const answer = insightsService.student.value.answer;
            expect(answer?.ok && [answer.value.requestsRaised, answer.value.hintsRead, answer.value.annotationsReceived, answer.value.reflectionsShared]).toEqual([
              raised,
              hints,
              received,
              shared
            ]);
          }
        );
        And("the student page shall carry the help and feedback panel after the calendar and lab analytics", () => {
          const page = readFileSync(join(ROOT, "apps/time/src/routes/[courseid]/[studentid]/+page.svelte"), "utf8");
          const tables = page.indexOf("<Tables ");
          const ifEnd = page.indexOf("{/if}", tables);
          expect(tables).toBeGreaterThan(0);
          expect(page.indexOf("<StudentInsights ")).toBeGreaterThan(ifEnd);
        });
      });
    }
  );

  Rule("While a course has fewer than 5 students with records in the chosen period, tutors shall show counts and withhold percentiles.", ({ RuleScenario }) => {
    RuleScenario("Four students: counts only", ({ Given, And, When, Then }) => {
      Given("{string} teaches the course", teaches);
      And("{number} students each asked for help at the step {string} on {string}, acknowledged after 1 to 4 minutes", many);
      When("{string} opens the course's insights for the day {string}", opensDay);
      Then("the step {string} shall show {number} requests and no median or 90th percentile wait", (_ctx, stepId: string, total: number) => {
        expect([step(stepId).total, step(stepId).medianWaitSeconds, step(stepId).p90WaitSeconds]).toEqual([total, null, null]);
      });
      And("the response times shall show counts and no percentiles", () => {
        const [day] = shown().responseTimes;
        expect(day.times.stuck.acknowledge).toEqual({ count: 4, median: null, p90: null });
      });
      And("the page shall say that only counts are shown", saysCountsOnly(true));
    });

    RuleScenario("Five students: percentiles are shown", ({ Given, And, When, Then }) => {
      Given("{string} teaches the course", teaches);
      And("{number} students each asked for help at the step {string} on {string}, acknowledged after 1 to 5 minutes", many);
      When("{string} opens the course's insights for the day {string}", opensDay);
      Then("the step {string} shall show {number} requests with a median wait of {number} seconds", withMedian);
      And("the page shall not say that only counts are shown", saysCountsOnly(false));
    });
  });

  Rule(
    "Tutors shall name every new table, view, channel and port of these contexts in ARCHITECTURE.md with its owning adapter, as Rules 0347 to 0352 require.",
    ({ RuleScenario }) => {
      RuleScenario("The insights views and ports are in the architecture document", ({ Given, Then, And }) => {
        let doc = "";
        const rowOf = (name: string) => doc.split("\n").find((line) => line.startsWith("|") && line.includes(`\`${name}\``)) ?? "";
        Given("the architecture document", () => {
          doc = readFileSync(join(ROOT, "ARCHITECTURE.md"), "utf8");
        });
        Then("it shall name {string}, {string} and {string} with {string}", (_ctx, a: string, b: string, c: string, adapter: string) => {
          for (const view of [a, b, c]) expect(rowOf(view), view).toContain(adapter);
        });
        And("its ports table shall name {string} with {string} and {string} with {string}", (_ctx, port: string, adapter: string, desk: string, deskAdapter: string) => {
          expect(rowOf(port)).toContain(adapter);
          expect(rowOf(desk)).toContain(deskAdapter);
        });
      });
    }
  );

  Rule(
    "Tutors shall keep the assistance, feedback and insights contexts from importing each other's use cases, reacting to each other only through application events and the Learning context's shared types.",
    ({ RuleScenario }) => {
      RuleScenario("No context's use cases import another's", ({ Given, Then }) => {
        const contexts = ["assistance", "feedback", "insights"];
        let imports: { context: string; from: string }[] = [];
        Given("the use cases of the assistance, feedback and insights contexts", () => {
          imports = contexts.flatMap((context) => {
            const dir = join(ROOT, "packages/application/src", context);
            const index = readFileSync(join(dir, "index.ts"), "utf8");
            const files = [...index.matchAll(/from "\.\/([^"]+)"/g)].map((m) => m[1]);
            expect(files.length).toBeGreaterThan(0);
            return files.flatMap((file) =>
              [...readFileSync(join(dir, file), "utf8").matchAll(/from "([^"]+)"/g)].map((m) => ({ context, from: m[1] }))
            );
          });
        });
        Then("none of them shall import another of those contexts' use case modules", () => {
          const crossing = imports.filter(({ context, from }) => contexts.some((other) => other !== context && (from.startsWith(`../${other}/`) || from === `@tutors/application/${other}`)));
          expect(imports.length).toBeGreaterThan(10);
          expect(crossing).toEqual([]);
        });
      });
    }
  );
});
