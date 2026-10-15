/**
 * Asking for help from a lab step (Rules 0397 to 0399, 0561, 0562): the reader's helpService over
 * the in-memory help desk, which runs the Assistance use cases as the person signed in.
 */
import "../../support/svelte-runes-shim.ts";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect, vi } from "vitest";
import type { HelpKind, HelpRequest } from "@tutors/domain/assistance";
import type { HelpDesk, HelpDeskResult } from "../../../../packages/application/src/ports/index.ts";
import type { StepRef } from "@tutors/domain/learning";
import { FixedClock, InMemoryHelpDesk, InMemoryNotesStore } from "../../../../packages/application/src/testing/index.ts";
import { anonymousAdapters, configureAdapters } from "../../../../packages/adapters/driving/svelte-state/src/adapters.ts";
import { helpService } from "../../../../packages/adapters/driving/svelte-state/src/assistance/help.svelte.ts";
import { notesService } from "../../../../packages/adapters/driving/svelte-state/src/learning/notes.svelte.ts";

const feature = await loadFeature("tests/bdd/features/student/help-button.feature");

/**
 * The student's desk as their reader composes it, with two faults a test can arrange: the next
 * action not kept (the reader's server answered 503), and a read that answers late, with the
 * request as it stood when the read ran.
 */
class StudentDesk implements HelpDesk {
  refuseNext = false;
  holdReads = false;
  held: Array<() => void> = [];
  reads = 0;
  constructor(readonly inner: InMemoryHelpDesk) {}
  private kept(run: () => Promise<HelpDeskResult>): Promise<HelpDeskResult> {
    if (!this.refuseNext) return run();
    this.refuseNext = false;
    return Promise.resolve({ ok: false, reason: "unavailable" });
  }
  ask: HelpDesk["ask"] = (ref, kind) => this.kept(() => this.inner.ask(ref, kind));
  act: HelpDesk["act"] = (id, action) => this.kept(() => this.inner.act(id, action));
  answerHint: HelpDesk["answerHint"] = (id, text) => this.kept(() => this.inner.answerHint(id, text));
  rate: HelpDesk["rate"] = (id, helped) => this.kept(() => this.inner.rate(id, helped));
  queue: HelpDesk["queue"] = (courseId) => this.inner.queue(courseId);
  mine = async (courseId: string): Promise<HelpRequest | null> => {
    this.reads++;
    const read = await this.inner.mine(courseId);
    if (!this.holdReads) return read;
    this.holdReads = false;
    return new Promise((resolve) => this.held.push(() => resolve(read)));
  };
}

describeFeature(feature, ({ Background, Rule, AfterEachScenario }) => {
  let desk: InMemoryHelpDesk;
  let ref: StepRef;
  let notes: InMemoryNotesStore;
  let student: StudentDesk;
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

  const signIn = (login: string) => {
    student = new StudentDesk(as(login));
    configureAdapters(anonymousAdapters({ anonymous: false, clock: desk.clock, helpDesk: student }));
  };
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

  Rule(
    "If a student's help action is not kept, then tutors shall tell the student it was not sent and send that same action again when the student retries.",
    ({ RuleScenario }) => {
      const notKept = () => (student.refuseNext = true);
      const toldNotSent = () => expect(helpService.failure.value).toBe("unavailable");
      const retries = async () => expect(await helpService.retry()).toBe(true);
      RuleScenario("A withdrawal that was not kept is sent again as a withdrawal", ({ Given, And, When, Then }) => {
        Given("{string} is signed in and asked for help as {string}", signedInAndAsked);
        And("the help desk does not keep the next action of {string}", notKept);
        When("{string} withdraws the request", async () => expect(await helpService.withdraw()).toBe(false));
        Then("the reader shall tell {string} it was not sent", toldNotSent);
        When("{string} retries", retries);
        Then("the request shall be {string}", (_ctx, state: string) => expect(request().state).toBe(state));
        And("{string} shall have asked for help once", () => expect(student.inner.calls.ask).toBe(1));
      });
      RuleScenario("A rating that was not kept is asked until it is kept", ({ Given, And, When, Then }) => {
        Given("{string} is signed in and asked for help as {string}", signedInAndAsked);
        And("{string} marks the request solved", async () => expect(await helpService.solved()).toBe(true));
        And("the help desk does not keep the next action of {string}", notKept);
        When("{string} answers that it helped", async () => expect(await helpService.rate(true)).toBe(false));
        Then("the reader shall tell {string} it was not sent", toldNotSent);
        And("the reader shall still ask whether the help helped", () => expect(helpService.asksRating()).toBe(true));
        When("{string} retries", retries);
        Then("the request shall record that it helped", () => expect(request().helped).toBe(true));
      });
    }
  );

  Rule(
    "Tutors shall show a student their help request as read after their latest action or arrival on a lab step, and read it again only while they are on a lab.",
    ({ RuleScenario }) => {
      const shownAs = (_ctx: unknown, state: string) => expect(helpService.request.value?.state).toBe(state);
      RuleScenario("A read that started before a withdrawal does not bring the request back", ({ Given, And, When, Then }) => {
        let read: Promise<void>;
        Given("{string} is signed in and asked for help as {string}", signedInAndAsked);
        And("the reader starts reading the request of {string}", async () => {
          student.holdReads = true;
          read = helpService.refresh();
          await vi.waitFor(() => expect(student.held).toHaveLength(1));
        });
        When("{string} withdraws the request", async () => expect(await helpService.withdraw()).toBe(true));
        And("the older read answers", async () => {
          student.held.shift()?.();
          await read;
        });
        Then("the reader shall show the request as {string}", shownAs);
      });
      RuleScenario("Leaving the lab stops reading, and coming back reads the request again", ({ Given, When, And, Then }) => {
        let readsWhenLeft = 0;
        Given("{string} is signed in and asked for help as {string}", signedInAndAsked);
        When("{string} leaves the lab", () => {
          helpService.leave();
          readsWhenLeft = student.reads;
        });
        And("{int} seconds pass on the lab", (_ctx, seconds: number) => vi.advanceTimersByTimeAsync(seconds * 1000));
        Then("the reader shall not have read the request since {string} left", () => expect(student.reads).toBe(readsWhenLeft));
        When("{string} acknowledges the request", async (_ctx, lecturer: string) => {
          expect((await as(lecturer).act(request().id, "acknowledge")).ok).toBe(true);
        });
        And("{string} comes back to the lab", () => helpService.arrive(ref, true));
        Then("the reader shall show the request as {string}", shownAs);
      });
    }
  );

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
