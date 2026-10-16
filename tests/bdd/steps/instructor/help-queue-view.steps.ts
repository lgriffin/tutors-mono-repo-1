/**
 * The help queue in Tutors Live (Rules 0393, 0395, 0396, 0407, 0563): helpQueueService over the in-memory help
 * desk and feed, the in-memory feedback desk over the same feed, a fixed clock and fake timers.
 */
import "../../support/svelte-runes-shim.ts";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect, vi } from "vitest";
import type { HelpKind } from "@tutors/domain/assistance";
import { FixedClock, InMemoryAssistanceFeed, InMemoryFeedbackDesk, InMemoryHelpDesk } from "../../../../packages/application/src/testing/index.ts";
import { anonymousAdapters, configureAdapters } from "../../../../packages/adapters/driving/svelte-state/src/adapters.ts";
import { helpQueueService, type QueueRow } from "../../../../packages/adapters/driving/svelte-state/src/assistance/queue.svelte.ts";

const feature = await loadFeature("tests/bdd/features/instructor/help-queue-view.feature");

describeFeature(feature, ({ Background, Rule, AfterEachScenario }) => {
  let desk: InMemoryHelpDesk;
  let feedback: InMemoryFeedbackDesk;
  let clock: FixedClock;
  let courseId: string;
  let lecturer: string;
  let online: Set<string>;
  let row: QueueRow;

  AfterEachScenario(() => {
    helpQueueService.reset();
    configureAdapters(anonymousAdapters());
    vi.useRealTimers();
  });

  /** Tutors Live's page, composed with or without the course's stream, opened by the lecturer. */
  const open = async (streamed: boolean) => {
    helpQueueService.reset();
    configureAdapters(
      anonymousAdapters({
        anonymous: false,
        clock,
        helpDesk: desk.as({ login: lecturer, name: null }),
        feedbackDesk: feedback.as({ login: lecturer, name: null }),
        assistanceFeed: streamed ? desk.feed : new InMemoryAssistanceFeed(false)
      })
    );
    await helpQueueService.start(courseId);
  };

  Background(({ Given }) => {
    Given("{string} teaches the course {string} and opens its help queue in Tutors Live at {string}", async (_ctx, login: string, course: string, at: string) => {
      vi.useFakeTimers();
      clock = new FixedClock(Date.parse(at));
      desk = new InMemoryHelpDesk({ clock, educators: { [course]: [login] } });
      feedback = new InMemoryFeedbackDesk({ clock, feed: desk.feed, educators: { [course]: [login] } });
      courseId = course;
      lecturer = login;
      online = new Set();
      await open(true);
    });
  });

  const pass = async (seconds: number) => {
    clock.advance(seconds * 1000);
    await vi.advanceTimersByTimeAsync(seconds * 1000);
  };
  const asks = async (_ctx: unknown, learner: string, kind: HelpKind, stepId: string, labRoute: string) => {
    expect((await desk.as({ login: learner, name: learner.toUpperCase() }).ask({ courseId, labRoute, stepId }, kind)).ok).toBe(true);
  };
  const rows = () => helpQueueService.rows((login) => online.has(login));
  const shows = (_ctx: unknown, learner: string) => expect(rows().map((r) => r.request.learnerId)).toEqual([learner]);
  const latestRow = () => (row = rows()[0]);

  Rule(
    "Tutors shall read a lecturer's help queue from stored rows every 60 seconds, show between reads each change the queue's stream brings, and keep the last queue on screen when a read fails.",
    ({ RuleScenario }) => {
      RuleScenario("Without a stream a new request shows at the next read", ({ Given, When, Then }) => {
        Given("the help queue has no stream", () => open(false));
        When("{string} asks for help as {string} on the step {string} of the lab {string}", asks);
        Then("the queue shall show no request", () => expect(rows()).toEqual([]));
        When("{int} seconds pass", (_ctx, seconds: number) => pass(seconds));
        Then("the queue shall show the request of {string}", shows);
      });
      RuleScenario("With a stream a new request shows at once", ({ Given, When, Then }) => {
        Given("the help queue is streamed", () => open(true));
        When("{string} asks for help as {string} on the step {string} of the lab {string}", asks);
        Then("the queue shall show the request of {string}", shows);
      });
      RuleScenario("A read that fails keeps the last queue", ({ Given, And, When, Then }) => {
        Given("{string} asks for help as {string} on the step {string} of the lab {string}", asks);
        And("{int} seconds pass", (_ctx, seconds: number) => pass(seconds));
        When("the help requests cannot be read", () => {
          desk.store.unavailable = true;
        });
        And("{int} more seconds pass", (_ctx, seconds: number) => pass(seconds));
        Then("the queue shall show the request of {string}", shows);
        And("the queue shall say it was last read at {string}", (_ctx, at: string) => {
          expect(helpQueueService.status.value).toBe("stale");
          expect(helpQueueService.readAt.value).toBe(Date.parse(at));
        });
      });
    }
  );

  Rule(
    "Tutors shall show a lecturer, for each open request, the student's name, the lab and step, the kind of help, the waiting time updating each second, and whether the student is still online.",
    ({ RuleScenario }) => {
      RuleScenario("A request shows who, where, what and how long, and the time moves", ({ Given, And, When, Then }) => {
        Given("the help queue is streamed", () => open(true));
        And("{string} is online on the course", (_ctx, learner: string) => void online.add(learner));
        When("{string} asks for help as {string} on the step {string} of the lab {string}", asks);
        And("{int} seconds pass", (_ctx, seconds: number) => pass(seconds));
        Then(
          "the queue's row shall show {string}, the lab {string}, the step {string} and the kind {string}",
          (_ctx, name: string, labRoute: string, stepId: string, kind: string) => {
            latestRow();
            expect(row.request).toMatchObject({ learnerName: name, kind, ref: { labRoute, stepId } });
          }
        );
        And("the row shall have waited {int} seconds", (_ctx, seconds: number) => expect(latestRow().waitingMs).toBe(seconds * 1000));
        And("the row shall show the student online", () => expect(latestRow().online).toBe(true));
        When("{int} second passes", (_ctx, seconds: number) => pass(seconds));
        Then("the row shall have waited {int} seconds", (_ctx, seconds: number) => expect(latestRow().waitingMs).toBe(seconds * 1000));
      });
      RuleScenario("A student who left the course shows offline", ({ Given, When, Then }) => {
        Given("the help queue is streamed", () => open(true));
        When("{string} asks for help as {string} on the step {string} of the lab {string}", asks);
        Then("the row shall show the student offline", () => expect(latestRow().online).toBe(false));
      });
    }
  );

  Rule("Tutors shall order the help queue by lecturer requests first, then by waiting time, longest first.", ({ RuleScenario }) => {
    RuleScenario("Lecturer requests lead, then the longest waiting", ({ Given, When, And, Then }) => {
      Given("the help queue is streamed", () => open(true));
      When("{string} asks for help as {string} on the step {string} of the lab {string}", asks);
      And("{int} seconds pass", (_ctx, seconds: number) => pass(seconds));
      And('"bob" asks for help as {string} on the step {string} of the lab {string}', (ctx, kind: HelpKind, stepId: string, labRoute: string) =>
        asks(ctx, "bob", kind, stepId, labRoute)
      );
      And("{int} more seconds pass", (_ctx, seconds: number) => pass(seconds));
      And('"carol" asks for help as {string} on the step {string} of the lab {string}', (ctx, kind: HelpKind, stepId: string, labRoute: string) =>
        asks(ctx, "carol", kind, stepId, labRoute)
      );
      Then("the queue shall list {string}, {string}, {string} in that order", (_ctx, a: string, b: string, c: string) => {
        expect(rows().map((r) => r.request.learnerId)).toEqual([a, b, c]);
      });
    });
  });

  Rule("If a request's stored lab or step is not valid URL-encoded text, then tutors shall show it in the help queue as stored.", ({ RuleScenario }) => {
    const names = (_ctx: unknown, lab: string, step: string) => expect(latestRow().where).toEqual({ lab, step });
    RuleScenario("A malformed step shows as stored", ({ Given, When, Then }) => {
      Given("the help queue is streamed", () => open(true));
      When("{string} asks for help as {string} on the step {string} of the lab {string}", asks);
      Then("the queue's row shall name the lab {string} and the step {string}", names);
    });
    RuleScenario("An encoded step shows decoded", ({ Given, When, Then }) => {
      Given("the help queue is streamed", () => open(true));
      When("{string} asks for help as {string} on the step {string} of the lab {string}", asks);
      Then("the queue's row shall name the lab {string} and the step {string}", names);
    });
  });

  Rule(
    "When a lecturer resolves a help request in the help queue, the live dashboard shall offer to turn it into an explanation for everyone on the request's step, pre-filled with that step and any hint.",
    ({ RuleScenario }) => {
      const requestOf = (learner: string) => desk.store.rows.find((r) => r.learnerId === learner)!;
      let draft = "";
      const offers = (_ctx: unknown, stepId: string, labRoute: string, start: string) => {
        const offered = helpQueueService.offers.value;
        expect(offered.map((r) => [r.ref.labRoute, r.ref.stepId])).toEqual([[labRoute, stepId]]);
        draft = helpQueueService.draftFor(offered[0]);
        expect(draft).toBe(start);
      };
      const noOffer = () => expect(helpQueueService.offers.value).toEqual([]);

      RuleScenario("An answered hint becomes an explanation for everyone on the step", ({ Given, And, When, Then }) => {
        Given("the help queue is streamed", () => open(true));
        And("{string} asks for help as {string} on the step {string} of the lab {string}", asks);
        When("{string} answers the request of {string} with the hint {string}", async (_ctx, _login: string, learner: string, hint: string) => {
          expect(await helpQueueService.answerHint(requestOf(learner).id, hint)).toBe(true);
        });
        Then("the queue shall offer an explanation for the step {string} of the lab {string} starting {string}", offers);
        When("{string} posts the explanation", async () => {
          expect(await helpQueueService.explain(helpQueueService.offers.value[0].id, draft)).toBe(true);
        });
        Then("everyone on the step {string} of the lab {string} shall have the explanation {string}", async (_ctx, stepId: string, labRoute: string, body: string) => {
          const seen = await feedback.as({ login: "alice", name: null }).step({ courseId, labRoute, stepId });
          expect(seen.broadcasts.map((a) => a.body)).toEqual([body]);
        });
        And("the queue shall say an explanation was posted on the step {string}", (_ctx, stepId: string) => {
          expect(helpQueueService.explanations.value.map((a) => a.anchor.ref.stepId)).toEqual([stepId]);
        });
        And("the queue shall offer no explanation", noOffer);
      });

      RuleScenario("A lecturer who passes posts nothing", ({ Given, And, When, Then }) => {
        Given("the help queue is streamed", () => open(true));
        And("{string} asks for help as {string} on the step {string} of the lab {string}", asks);
        When("{string} resolves the request of {string}", async (_ctx, _login: string, learner: string) => {
          expect(await helpQueueService.resolve(requestOf(learner).id)).toBe(true);
        });
        Then("the queue shall offer an explanation for the step {string} of the lab {string} starting {string}", offers);
        When("{string} passes on the explanation", () => helpQueueService.skipExplain(helpQueueService.offers.value[0].id));
        Then("the queue shall offer no explanation", noOffer);
        And("nothing shall have been broadcast on the course", () => expect(feedback.store.annotations).toEqual([]));
      });
    }
  );
});
