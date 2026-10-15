/** Learning insights (Rules 0410, 0411), through the Insights use cases over the in-memory read port. */
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { openRequest, type HelpKind, type HelpRequest } from "@tutors/domain/assistance";
import type { Annotation } from "@tutors/domain/feedback";
import type { StepDiagnostic } from "@tutors/domain/insights";
import type { StepRef } from "@tutors/domain/learning";
import { stepDiagnostics } from "../../../../packages/application/src/index.ts";
import { InMemoryInsightsRead } from "../../../../packages/application/src/testing/index.ts";

const feature = await loadFeature("tests/bdd/features/instructor/learning-insights.feature");

type Row = { learner: string; kind: string; requested: string; acknowledged: string; closed: string; reason: string };

describeFeature(feature, ({ Background, Rule }) => {
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
    });
  });

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
});
