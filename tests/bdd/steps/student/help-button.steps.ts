/**
 * Asking for help from a lab step (Rules 0397 to 0399): the reader's helpService over the in-memory
 * help desk, which runs the Assistance use cases as the person signed in.
 */
import "../../support/svelte-runes-shim.ts";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect, vi } from "vitest";
import type { HelpKind } from "@tutors/domain/assistance";
import type { StepRef } from "@tutors/domain/learning";
import { FixedClock, InMemoryHelpDesk, InMemoryNotesStore } from "../../../../packages/application/src/testing/index.ts";
import { anonymousAdapters, configureAdapters } from "../../../../packages/adapters/driving/svelte-state/src/adapters.ts";
import { helpService } from "../../../../packages/adapters/driving/svelte-state/src/assistance/help.svelte.ts";
import { notesService } from "../../../../packages/adapters/driving/svelte-state/src/learning/notes.svelte.ts";

const feature = await loadFeature("tests/bdd/features/student/help-button.feature");

describeFeature(feature, ({ Background, Rule, AfterEachScenario }) => {
  let desk: InMemoryHelpDesk;
  let ref: StepRef;
  let notes: InMemoryNotesStore;
  const as = (login: string | null) => desk.as(login ? { login, name: login.toUpperCase() } : null);
  const request = () => desk.store.rows[0];

  AfterEachScenario(() => {
    helpService.reset();
    notesService.reset();
    configureAdapters(anonymousAdapters());
    vi.useRealTimers();
  });

  Background(({ Given, And }) => {
    Given("{string} teaches the course {string}", (_ctx, lecturer: string, courseId: string) => {
      vi.useFakeTimers();
      helpService.reset();
      desk = new InMemoryHelpDesk({ clock: new FixedClock(), educators: { [courseId]: [lecturer] } });
    });
    And("{string} is on the step {string} of the lab {string} in the course {string}", (_ctx, _learner: string, stepId: string, labRoute: string, courseId: string) => {
      ref = { courseId, labRoute, stepId };
    });
  });

  const signIn = (login: string) => configureAdapters(anonymousAdapters({ anonymous: false, clock: desk.clock, helpDesk: as(login) }));
  const signedInAndAsked = async (_ctx: unknown, learner: string, kind: HelpKind) => {
    signIn(learner);
    await helpService.arrive(ref, true);
    expect(await helpService.ask(kind)).toBe(true);
  };
  const lecturerResolves = async (_ctx: unknown, lecturer: string) => {
    expect((await as(lecturer).act(request().id, "resolve")).ok).toBe(true);
  };
  const readsAgain = () => helpService.refresh();
  const answersHint = async (_ctx: unknown, lecturer: string, hint: string) => {
    expect((await as(lecturer).answerHint(request().id, hint)).ok).toBe(true);
  };

  Rule(
    "When a lecturer answers a hint request with a typed hint, tutors shall show the hint to that student on the step and resolve the request as helped by a hint.",
    ({ RuleScenario }) => {
      RuleScenario("The student reads the lecturer's hint on the step", ({ Given, When, And, Then }) => {
        Given("{string} is signed in and asked for help as {string}", signedInAndAsked);
        When("{string} answers the request with the hint {string}", answersHint);
        And("the reader reads the request of {string} again", readsAgain);
        Then("the step shall show the hint {string}", (_ctx, hint: string) => expect(helpService.hint()).toBe(hint));
        And("the request shall be resolved as helped by a hint", () => {
          expect(request()).toMatchObject({ state: "resolved", closed: { reason: "hint" } });
          expect(helpService.request.value?.closed?.reason).toBe("hint");
        });
      });
      RuleScenario("The hint stays on the step it was asked from", ({ Given, When, And, Then }) => {
        Given("{string} is signed in and asked for help as {string}", signedInAndAsked);
        When("{string} answers the request with the hint {string}", answersHint);
        And("{string} moves to the step {string}", async (_ctx, _learner: string, stepId: string) => {
          await helpService.arrive({ ...ref, stepId }, true);
          await helpService.refresh();
          expect(helpService.request.value?.hintText).toBeTruthy();
        });
        Then("the step shall show no hint", () => expect(helpService.hint()).toBeNull());
      });
    }
  );

  Rule("When a request is resolved, tutors shall ask the student once whether it helped and record the answer against the request.", ({ RuleScenario }) => {
    const asks = () => expect(helpService.asksRating()).toBe(true);
    const asksNoMore = () => expect(helpService.asksRating()).toBe(false);
    RuleScenario("The student says the lecturer's help helped", ({ Given, When, And, Then }) => {
      Given("{string} is signed in and asked for help as {string}", signedInAndAsked);
      When("{string} resolves the request", lecturerResolves);
      And("the reader reads the request of {string} again", readsAgain);
      Then("the reader shall ask whether the help helped", asks);
      When("{string} answers that it helped", async () => expect(await helpService.rate(true)).toBe(true));
      Then("the request shall record that it helped", () => expect(request().helped).toBe(true));
      And("the reader shall not ask again", async () => {
        await helpService.refresh();
        asksNoMore();
      });
    });
    RuleScenario("The student marking it solved is asked too", ({ Given, When, Then }) => {
      Given("{string} is signed in and asked for help as {string}", signedInAndAsked);
      When("{string} marks the request solved", async () => expect(await helpService.solved()).toBe(true));
      Then("the reader shall ask whether the help helped", asks);
    });
    RuleScenario("Closing the question without an answer is not asked again", ({ Given, When, And, Then }) => {
      Given("{string} is signed in and asked for help as {string}", signedInAndAsked);
      When("{string} resolves the request", lecturerResolves);
      And("the reader reads the request of {string} again", readsAgain);
      And("{string} closes the question", () => {
        asks();
        helpService.dismiss();
      });
      And("the reader reads the request of {string} once more", readsAgain);
      Then("the reader shall not ask again", asksNoMore);
      And("the request shall record no answer", () => expect(request().helped).toBeNull());
    });
  });

  Rule("Tutors shall hide the help control in anonymous mode and for visitors who are not signed in, and keep the lab usable without it.", ({ RuleScenario, RuleScenarioOutline }) => {
    RuleScenario("A signed-in student is offered the help control", ({ Given, When, Then }) => {
      Given("{string} is signed in to the reader", (_ctx, learner: string) => signIn(learner));
      When("{string} arrives at the step", () => helpService.arrive(ref, true));
      Then("the help control shall be offered", () => expect(helpService.available.value).toBe(true));
    });
    RuleScenarioOutline("The help control is hidden from a visitor who is not signed in, and in anonymous mode", ({ Given, When, Then, And }, variables) => {
      Given("the reader is <mode>", () => {
        notes = new InMemoryNotesStore();
        const anonymous = variables.mode === "in anonymous mode";
        configureAdapters(anonymousAdapters({ anonymous, clock: desk.clock, helpDesk: desk, notes }));
      });
      When("a visitor arrives at the step", async () => {
        // In anonymous mode nobody can sign in; the control stays hidden whatever the page believes.
        await helpService.arrive(ref, variables.mode === "in anonymous mode");
        expect(await helpService.ask("stuck")).toBe(false);
      });
      Then("the help control shall be hidden", () => expect(helpService.available.value).toBe(false));
      And("nothing shall have been asked of the help desk", () => expect(Object.values(desk.calls).reduce((a, b) => a + b, 0)).toBe(0));
      And("the step's private notes shall still be kept", async () => {
        await notesService.arrive(ref);
        notesService.edit("My own note");
        await notesService.flush();
        expect((await notes.forCourse(ref.courseId)).map((n) => n.body)).toEqual(["My own note"]);
      });
    });
  });
});
