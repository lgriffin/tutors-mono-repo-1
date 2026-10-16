/**
 * Lecturer feedback on a lab step (Rules 0403, 0404, 0406, 0408, 0409, 0566, 0568, 0569, 0570): the reader's
 * feedbackService over the in-memory feedback desk, which runs the Feedback use cases as the person
 * signed in, and the reader's markdown renderer and sanitiser.
 */
import "../../support/svelte-runes-shim.ts";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect, vi } from "vitest";
import type { Annotation } from "@tutors/domain/feedback";
import { stepRefOfRoute, type StepRef } from "@tutors/domain/learning";
import type { AssistanceFeed, FeedbackDeskResult } from "../../../../packages/application/src/ports/index.ts";
import { FixedClock, InMemoryAssistanceFeed, InMemoryFeedbackDesk } from "../../../../packages/application/src/testing/index.ts";
import { anonymousAdapters, configureAdapters } from "../../../../packages/adapters/driving/svelte-state/src/adapters.ts";
import { feedbackService } from "../../../../packages/adapters/driving/svelte-state/src/feedback/step.svelte.ts";
import { markdownRenderer } from "../../../../packages/adapters/driven/render-markdown/src/index.ts";
import { sanitizeHtml } from "../../../../packages/adapters/driving/ui-primitives/src/utils/sanitize.ts";

const feature = await loadFeature("tests/bdd/features/student/step-feedback.feature");

describeFeature(feature, ({ Background, Rule, AfterEachScenario }) => {
  let desk: InMemoryFeedbackDesk;
  let clock: FixedClock;
  let ref: StepRef;
  let watched: string[];
  let revoked: FeedbackDeskResult;
  let received: Annotation[];
  const snippets: Record<string, string> = {};
  const as = (login: string | null) => desk.as(login ? { login, name: login.toUpperCase() } : null);
  const at = (stepId: string): StepRef => ({ ...ref, stepId });
  const byBody = (body: string) => desk.store.annotations.find((a) => a.body === body)!;

  /** The reader's adapters for a person: their feedback desk, and a feed that records any channel joined. */
  function open(login: string | null): Promise<void> {
    const feed: AssistanceFeed = new InMemoryAssistanceFeed();
    const watch = feed.watch.bind(feed);
    feed.watch = (courseId, listener) => (watched.push(courseId), watch(courseId, listener));
    configureAdapters({ ...anonymousAdapters({ clock, renderer: markdownRenderer }), anonymous: false, feedbackDesk: as(login), assistanceFeed: feed });
    return feedbackService.arrive(ref, login);
  }

  AfterEachScenario(() => {
    feedbackService.reset();
    configureAdapters(anonymousAdapters());
    vi.useRealTimers();
  });

  Background(({ Given, And }) => {
    Given("{string} teaches the course {string}", (_ctx, lecturer: string, courseId: string) => {
      vi.useFakeTimers();
      feedbackService.reset();
      watched = [];
      clock = new FixedClock();
      desk = new InMemoryFeedbackDesk({ clock, educators: { [courseId]: [lecturer] } });
    });
    And("{string} is on the step {string} of the lab {string} in the course {string}", (_ctx, _learner: string, stepId: string, labRoute: string, courseId: string) => {
      ref = { courseId, labRoute, stepId };
    });
  });

  const broadcast = async (_ctx: unknown, lecturer: string, body: string, stepId: string) => {
    expect((await as(lecturer).broadcast(at(stepId), body)).ok).toBe(true);
  };
  const writes = async (_ctx: unknown, lecturer: string, body: string, learnerId: string, stepId: string) => {
    expect((await as(lecturer).annotate({ ref: at(stepId) }, { learnerId }, body)).ok).toBe(true);
  };
  const opens = (_ctx: unknown, login: string) => open(login);
  const clockReads = (_ctx: unknown, iso: string) => clock.set(iso);
  const pass = async (_ctx: unknown, seconds: number) => {
    clock.advance(seconds * 1000);
    await vi.advanceTimersByTimeAsync(seconds * 1000);
  };
  const banner = (_ctx: unknown, body: string) => expect(feedbackService.banners().map((a) => a.body)).toEqual([body]);
  const card = (_ctx: unknown, body: string) => expect(feedbackService.view.value.personal.map((a) => a.body)).toEqual([body]);
  const nothing = () => {
    expect(feedbackService.banners()).toEqual([]);
    expect(feedbackService.view.value.personal).toEqual([]);
  };
  /** The store's reads of the step while the student opened it. */
  let reads = 0;
  const readOnce = () => expect(reads).toBe(1);
  const history = () => feedbackService.view.value.history?.annotations ?? [];

  Rule(
    "When a student opens a lab step, the reader shall show every unrevoked broadcast for that step above the content and every annotation addressed to that student below it, from one query.",
    ({ RuleScenario }) => {
      RuleScenario("A broadcast and a personal annotation show where they belong", ({ Given, And, But, When, Then }) => {
        Given("{string} has broadcast {string} on the step {string}", broadcast);
        And("{string} has written {string} to {string} on the step {string}", writes);
        But("{string} has written {string} to {string} on the step {string}", writes);
        When("{string} opens the step", async (_ctx, login: string) => {
          const forStep = vi.spyOn(desk.store, "forStep");
          await open(login);
          reads = forStep.mock.calls.length;
        });
        Then("the reader shall show the banner {string} above the step", banner);
        And("the reader shall show the card {string} below the step", card);
        And("the reader shall show no other annotation", () => {
          expect(feedbackService.view.value.broadcasts).toHaveLength(1);
          expect(feedbackService.view.value.personal).toHaveLength(1);
        });
        And("the step's feedback shall have been read once", readOnce);
      });
      RuleScenario("A visitor who is not signed in sees no feedback", ({ Given, When, Then }) => {
        Given("{string} has broadcast {string} on the step {string}", broadcast);
        When("a visitor who is not signed in opens the step", () => open(null));
        Then("the reader shall show no banner and no card", nothing);
      });
    }
  );

  Rule("While a student stays on a lab step, the reader shall refresh its annotations every 60 seconds without joining a realtime channel.", ({ RuleScenario }) => {
    RuleScenario("A broadcast posted while the student reads arrives within a minute", ({ Given, When, And, Then }) => {
      Given("{string} opens the step", opens);
      When("{string} broadcasts {string} on the step {string}", broadcast);
      And("{number} seconds pass", pass);
      Then("the reader shall show the banner {string} above the step", banner);
      And("the reader shall have joined no realtime channel for it", () => expect(watched).toEqual([]));
    });
    RuleScenario("A student who left the step reads no more", ({ Given, And, When, Then }) => {
      let forStep: ReturnType<typeof vi.spyOn>;
      Given("{string} opens the step", async (_ctx, login: string) => {
        forStep = vi.spyOn(desk.store, "forStep");
        await open(login);
      });
      And("{string} leaves the step", () => feedbackService.leave());
      When("{number} seconds pass", pass);
      Then("the step's feedback shall have been read once", () => expect(forStep.mock.calls.length).toBe(1));
    });
  });

  Rule(
    "When an educator revokes an annotation, the reader shall stop showing it to students on their next refresh and keep it in the review history with the revocation time.",
    ({ RuleScenario }) => {
      RuleScenario("A revoked broadcast leaves the step and stays in the history", ({ Given, And, When, Then }) => {
        Given("{string} has broadcast {string} on the step {string}", broadcast);
        And("{string} opens the step", opens);
        And("the clock reads {string}", clockReads);
        When("{string} revokes the broadcast {string}", async (_ctx, lecturer: string, body: string) => {
          expect((await as(lecturer).revoke(byBody(body).id)).ok).toBe(true);
        });
        And("{number} seconds pass", pass);
        Then("the reader shall show no banner and no card", nothing);
        And("the step's history for {string} shall list {string} revoked at {string}", async (_ctx, lecturer: string, body: string, iso: string) => {
          await open(lecturer);
          expect(history().map((a) => [a.body, a.revokedAt])).toEqual([[body, iso]]);
        });
      });
      RuleScenario("A student cannot revoke", ({ Given, When, Then }) => {
        Given("{string} has broadcast {string} on the step {string}", broadcast);
        When("{string} tries to revoke the broadcast {string}", async (_ctx, login: string, body: string) => {
          revoked = await as(login).revoke(byBody(body).id);
        });
        Then("the revoke shall be refused as {string}", (_ctx, reason: string) => expect(revoked).toEqual({ ok: false, reason }));
      });
    }
  );

  Rule("The reader shall render annotation bodies as markdown through the content renderer, sanitised as lab content is.", ({ RuleScenario }) => {
    RuleScenario("Markdown is rendered and a script is removed", ({ Given, When, Then, And }) => {
      let html = "";
      Given("{string} has broadcast {string} on the step {string}", broadcast);
      When("{string} opens the step", async (_ctx, login: string) => {
        await open(login);
        html = sanitizeHtml(feedbackService.render(feedbackService.banners()[0].body));
      });
      Then("the banner shall render {string} in bold", (_ctx, word: string) => expect(html).toContain(`<strong>${word}</strong>`));
      And("the banner shall hold no script", () => expect(html).not.toMatch(/<script|alert\(1\)/));
    });
  });

  Rule(
    "The reader shall show a student the history of annotations they received in a course, newest first, and show an educator what was broadcast on a step and when.",
    ({ RuleScenario }) => {
      RuleScenario("A student's history is newest first and leaves out another student's", ({ Given, And, But, When, Then }) => {
        Given("the clock reads {string}", clockReads);
        And("{string} has broadcast {string} on the step {string}", broadcast);
        And("the clock reads {string}", clockReads);
        And("{string} has written {string} to {string} on the step {string}", writes);
        But("{string} has written {string} to {string} on the step {string}", writes);
        When("{string} reads the feedback they received in {string}", async (_ctx, login: string, courseId: string) => {
          await open(login);
          await feedbackService.readReceived(courseId);
          received = feedbackService.received.value ?? [];
        });
        Then("the history shall read {string}, then {string}", (_ctx, first: string, second: string) => expect(received.map((a) => a.body)).toEqual([first, second]));
      });
      RuleScenario("The educator sees what was broadcast on the step and when", ({ Given, And, When, Then }) => {
        Given("the clock reads {string}", clockReads);
        And("{string} has broadcast {string} on the step {string}", broadcast);
        When("{string} opens the step", opens);
        Then("the step's history for {string} shall list {string} posted at {string}", (_ctx, _lecturer: string, body: string, iso: string) => {
          expect(history().map((a) => [a.body, a.audience.kind, a.createdAt])).toEqual([[body, "everyone", iso]]);
        });
      });
      RuleScenario("A student sees no step history", ({ When, Then }) => {
        When("{string} opens the step", opens);
        Then("the reader shall offer {string} no step history", () => expect(feedbackService.view.value.history).toBeNull());
      });
    }
  );

  Rule(
    "When a lecturer sends feedback on a snippet shared from a lab step, the reader shall show it below that step to the student who shared the snippet only.",
    ({ RuleScenario }) => {
      RuleScenario("Feedback on a snippet lands on the step it was shared from", ({ Given, When, And, Then }) => {
        Given("{string} shared the snippet {string} from the route {string}", (_ctx, _learner: string, id: string, route: string) => {
          snippets[id] = route;
        });
        When("{string} sends {string} on the snippet {string} from Tutors Time", async (_ctx, lecturer: string, body: string, id: string) => {
          const step = stepRefOfRoute(ref.courseId, snippets[id]);
          expect(step).toEqual(ref);
          expect((await as(lecturer).annotate({ ref: step!, snippetId: id }, { learnerId: "alice" }, body)).ok).toBe(true);
        });
        And("{string} opens the step", opens);
        Then("the reader shall show the card {string} below the step", card);
        And("the card shall say it is on their snippet", () => expect(feedbackService.view.value.personal[0].anchor).toMatchObject({ kind: "snippet", snippetId: "gist-7" }));
      });
      RuleScenario("A snippet shared from a lab's own page offers no feedback", ({ Given, Then }) => {
        Given("{string} shared the snippet {string} from the route {string}", (_ctx, _learner: string, id: string, route: string) => {
          snippets[id] = route;
        });
        Then("Tutors Time shall offer no feedback on the snippet {string}", (_ctx, id: string) => expect(stepRefOfRoute(ref.courseId, snippets[id])).toBeNull());
      });
    }
  );

  Rule(
    "When a signed-in student shares the note of a lab step with the course's lecturers, the reader shall send a copy as a reflection that the step's history shows its educators, and say whether it was sent.",
    ({ RuleScenario }) => {
      let sent = false;
      const shares = async (_ctx: unknown, _login: string, body: string) => {
        sent = await feedbackService.share({ ref, body, kind: "reflection", updatedAt: clock.now().toISOString() });
      };
      RuleScenario("A shared note reaches the lecturer", ({ Given, When, Then, And }) => {
        Given("{string} opens the step", opens);
        When("{string} shares the note {string} with the lecturer", shares);
        Then("the reader shall say the note was sent", () => expect([sent, feedbackService.failure.value]).toEqual([true, null]));
        And("the step's reflections for {string} shall read {string} from {string}", async (_ctx, lecturer: string, body: string, learner: string) => {
          await open(lecturer);
          expect(feedbackService.view.value.history?.reflections.map((r) => [r.body, r.learnerId])).toEqual([[body, learner]]);
        });
      });
      RuleScenario("An empty note is not sent", ({ Given, When, Then }) => {
        Given("{string} opens the step", opens);
        When("{string} shares the note {string} with the lecturer", shares);
        Then("the reader shall say the note was not sent, as {string}", (_ctx, reason: string) => expect([sent, feedbackService.failure.value]).toEqual([false, reason]));
      });
    }
  );

  Rule(
    "When an educator replies to a reflection shared on a lab step, the reader shall show the reply below that step to the student who shared the reflection only.",
    ({ RuleScenario }) => {
      const reflected = async (_ctx: unknown, login: string, body: string) => {
        expect((await as(login).reflect({ ref, body, kind: "reflection", updatedAt: clock.now().toISOString() })).ok).toBe(true);
      };
      const replies = async (_ctx: unknown, lecturer: string, body: string, learner: string) => {
        await open(lecturer);
        const reflection = feedbackService.view.value.history!.reflections.find((r) => r.learnerId === learner)!;
        expect(await feedbackService.reply(reflection, body)).toBe(true);
      };
      RuleScenario("The student who reflected reads the reply", ({ Given, When, And, Then }) => {
        Given("{string} has shared the note {string} on the step", reflected);
        When("{string} replies {string} to the reflection from {string}", replies);
        And("{string} opens the step", opens);
        Then("the reader shall show the card {string} below the step", card);
        And("the card shall say it is on their reflection", () => expect(feedbackService.view.value.personal[0].anchor).toMatchObject({ kind: "reflection" }));
      });
      RuleScenario("Another student does not see the reply", ({ Given, When, And, Then }) => {
        Given("{string} has shared the note {string} on the step", reflected);
        When("{string} replies {string} to the reflection from {string}", replies);
        And("{string} opens the step", opens);
        Then("the reader shall show no banner and no card", nothing);
      });
    }
  );

  Rule("When someone else signs in on the same browser, the reader shall forget the feedback it read for the last person before reading any for them.", ({ RuleScenario }) => {
    RuleScenario("The next student sees none of the last student's feedback", ({ Given, And, When, Then }) => {
      let pending: Promise<void>;
      Given("{string} has written {string} to {string} on the step {string}", writes);
      And("{string} reads the feedback they received in {string}", async (_ctx, login: string, courseId: string) => {
        await open(login);
        await feedbackService.readReceived(courseId);
        expect(feedbackService.received.value).toHaveLength(1);
      });
      When("{string} opens the step", (_ctx, login: string) => {
        pending = open(login);
      });
      Then("the reader shall show no banner and no card", nothing);
      And("the reader shall hold no received feedback until {string} reads it", async () => {
        expect(feedbackService.received.value).toBeNull();
        await pending;
        nothing();
      });
    });
  });
});
