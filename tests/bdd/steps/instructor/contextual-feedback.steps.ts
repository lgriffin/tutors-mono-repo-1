/** Contextual feedback (Rules 0400 to 0402), through the Feedback use cases over the in-memory adapters. */
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import type { StepRef } from "@tutors/domain/learning";
import { annotate, type AnnotateResult, type AnnotationInput } from "../../../../packages/application/src/index.ts";
import { FixedClock, InMemoryFeedbackStore, RecordingPublisher } from "../../../../packages/application/src/testing/index.ts";

const feature = await loadFeature("tests/bdd/features/instructor/contextual-feedback.feature");

describeFeature(feature, ({ Background, Rule }) => {
  let clock: FixedClock;
  let store: InMemoryFeedbackStore;
  let publisher: RecordingPublisher;
  let educators: string[];
  let ref: StepRef;
  let result: AnnotateResult;

  Background(({ Given, And }) => {
    Given("{string} teaches the course {string}", (_ctx, lecturer: string) => {
      clock = new FixedClock();
      store = new InMemoryFeedbackStore();
      publisher = new RecordingPublisher();
      educators = [lecturer];
    });
    And("the step {string} of the lab {string} in the course {string}", (_ctx, stepId: string, labRoute: string, courseId: string) => {
      ref = { courseId, labRoute, stepId };
    });
  });

  const post = async (login: string, input: Omit<AnnotationInput, "body">) => {
    result = await annotate({ store, clock, educatorsOf: async () => educators, publish: (e) => publisher.publish(e) })(
      { ...input, body: "Everyone on this step: await the fetch." },
      { login }
    );
  };
  /** The composer's wording for an anchor and an audience, as the outline's columns spell them. */
  const anchorOf = (text: string) => {
    const snippet = /the snippet "([^"]+)"/.exec(text)?.[1];
    const reflection = /the reflection "([^"]+)"/.exec(text)?.[1];
    return { ref, snippetId: snippet ?? null, reflectionId: reflection ?? null };
  };
  const audienceOf = (text: string) => (text === "everyone on the step" ? { everyone: true } : { learnerId: text.replace(/"/g, "") });
  const storedNone = () => expect(store.annotations).toEqual([]);
  const refusedAs = (_ctx: unknown, reason: string) => expect(result).toMatchObject({ ok: false, detail: reason, status: 400 });

  Rule(
    "Tutors shall anchor an annotation to exactly one of a lab step, a submission or a shared reflection, with an audience of one student or everyone on the step.",
    ({ RuleScenarioOutline, RuleScenario }) => {
      RuleScenarioOutline("Each anchor and audience is accepted", ({ When, Then, And }, variables) => {
        When("{string} annotates <anchor> for <audience>", (_ctx, login: string) => post(login, { anchor: anchorOf(variables.anchor), audience: audienceOf(variables.audience) }));
        Then('the annotation shall be anchored to the "<kind>" at the step {string}', (_ctx, stepId: string) => {
          if (!result.ok) throw new Error(result.reason);
          expect(result.annotation.anchor).toMatchObject({ kind: variables.kind, ref: { ...ref, stepId } });
        });
        And('the annotation shall be addressed to "<to>"', () => {
          if (!result.ok) throw new Error(result.reason);
          const audience = result.annotation.audience;
          expect(audience.kind === "everyone" ? "everyone" : audience.learnerId).toBe(variables.to);
        });
      });
      RuleScenario("Two anchors are refused", ({ When, Then, And }) => {
        When(
          "{string} annotates the snippet {string} and the reflection {string} for {string}",
          (_ctx, login: string, snippetId: string, reflectionId: string, learnerId: string) => post(login, { anchor: { ref, snippetId, reflectionId }, audience: { learnerId } })
        );
        Then("the annotation shall be refused as {string}", refusedAs);
        And("tutors shall have stored no annotation", storedNone);
      });
      RuleScenario("Two audiences are refused", ({ When, Then, And }) => {
        When("{string} annotates the step for {string} and everyone on the step", (_ctx, login: string, learnerId: string) =>
          post(login, { anchor: { ref }, audience: { learnerId, everyone: true } })
        );
        Then("the annotation shall be refused as {string}", refusedAs);
        And("tutors shall have stored no annotation", storedNone);
      });
    }
  );

  const everyone = (_ctx: unknown, login: string) => post(login, { anchor: { ref }, audience: { everyone: true } });

  Rule("When an educator posts an annotation, tutors shall store it with the author and time and publish a feedback-posted event.", ({ RuleScenario }) => {
    RuleScenario("An annotation is stored and announced", ({ Given, When, Then, And }) => {
      Given("the clock reads {string}", (_ctx, at: string) => clock.set(at));
      When("{string} annotates the step for everyone on the step", everyone);
      Then("tutors shall have stored the annotation by {string} at {string}", (_ctx, login: string, at: string) => {
        expect(store.annotations.map((a) => [a.authorId, a.createdAt])).toEqual([[login, at]]);
      });
      And("tutors shall have published one feedback-posted event for it", () => {
        expect(publisher.events).toEqual([{ type: "feedback-posted", annotation: store.annotations[0] }]);
      });
    });
  });

  Rule("If an actor who is not in the course's educator list posts an annotation, then tutors shall refuse it with 403 and store nothing.", ({ RuleScenario }) => {
    RuleScenario("A student cannot annotate", ({ When, Then, And }) => {
      When("{string} annotates the step for everyone on the step", everyone);
      Then("the annotation shall be refused with {number}", (_ctx, status: number) => expect(result).toMatchObject({ ok: false, reason: "forbidden", status }));
      And("tutors shall have stored no annotation", storedNone);
      And("tutors shall have published no feedback-posted event", () => expect(publisher.events).toEqual([]));
    });
  });
});
