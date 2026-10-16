import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect, vi } from "vitest";

// The seams: the `pg` driver (the in-process store), the environments, SvelteKit and the identity
// adapter. Everything between them is product code.
vi.mock("pg", async () => (await import("../../support/backend.ts")).pgModule);
vi.mock("$app/env/public", async () => (await import("../../support/backend.ts")).publicEnv);
// `$app/env` and `$app/navigation` are aliased to one stub file, so one mock serves both.
vi.mock("$app/env", () => ({ browser: true, goto: vi.fn() }));
vi.mock("$app/env/private", async () => (await import("../../support/backend.ts")).privateEnv);

import { ALL_COURSES_CHANNEL, freshBrowser, githubUser, labsOf, loEventArrives, openLo, readerServer, publishedCourse, signIn, storedActivity } from "../../support/connect.ts";
import { backend, settle } from "../../support/backend.ts";
import type { HubMessage } from "@tutors/realtime-valkey";
import type { Course } from "../../../../packages/jsr/model/src/tutors.ts";
import { presenceService } from "../../../../packages/adapters/driving/svelte-state/src/community/services/presence.svelte.ts";
import type { LoRecord } from "../../../../packages/adapters/driving/svelte-state/src/community/types.svelte.ts";
import { tutorsConnectService } from "../../../../packages/adapters/driving/svelte-state/src/connect/services/connect.svelte.ts";

const feature = await loadFeature("tests/bdd/features/student/live-presence.feature");

describeFeature(feature, ({ Background, Scenario, Rule, AfterEachScenario }) => {
  let course: Course;

  const lab = (n: number) => labsOf(course)[n - 1];
  const online = () => presenceService.studentsOnline.value;
  const card = (name: string) => online().find((lo) => lo.user?.fullName === name);
  const names = () => online().map((lo) => lo.user?.fullName);
  /**
   * A Tutors Live server subscribed to the course's and the platform's activity topics on the hub,
   * as it is while a Live tab streams them: what it heard is what reached other participants.
   */
  const heard: { topic: string; message: HubMessage }[] = [];
  const unsubscribes: (() => Promise<void>)[] = [];
  /** Every lo-event broadcast for this browser's activity (by the reader's server), on the course topic and the all-courses topic. */
  const broadcasts = () => heard.filter((h) => h.message.event === "lo-event").map((h) => h.message.payload as LoRecord);
  const opens = (_ctx: unknown, _name: string, n: number) => openLo(course, lab(n));
  /** Another student's browser stores their activity, and the reader's next 60-second refresh reads it. */
  const arrives = async (name: string, n: number) => {
    await storedActivity(name, course, lab(n), 0);
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
  };

  AfterEachScenario(async () => {
    presenceService.stopPresenceListener();
    vi.useRealTimers();
    for (const unsubscribe of unsubscribes.splice(0)) await unsubscribe();
  });

  Background(({ Given, And }) => {
    Given("the course {string} is published with {number} labs", async (_ctx, courseId: string, labCount: number) => {
      await freshBrowser();
      heard.length = 0;
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
      course = publishedCourse(courseId, labCount);
    });
    And("the student {string} is signed in", (_ctx, name: string) => signIn(githubUser(name)));
    And("a live dashboard is watching the course and the platform feeds", async () => {
      for (const topic of [course.courseId, ALL_COURSES_CHANNEL]) {
        unsubscribes.push(await backend.hub.subscribe(topic, (message) => heard.push({ topic, message })));
      }
    });
  });

  Scenario("See online students count", ({ Given, When, Then }) => {
    Given("{string} has opened lab {number} of the course", opens);
    When("{string} and {string} view lab {number} of the course", async (_ctx, first: string, second: string, n: number) => {
      await storedActivity(first, course, lab(n), 0);
      await arrives(second, n);
    });
    Then("the system shall display {number} students currently online", (_ctx, count: number) => {
      expect(online()).toHaveLength(count);
      expect(presenceService.listeningTo).toBe(course.courseId);
    });
  });

  Scenario("Receive presence updates", ({ Given, When, Then, And }) => {
    Given("{string} has opened lab {number} of the course", opens);
    When("another student {string} joins the course at lab {number}", (_ctx, name: string, n: number) => arrives(name, n));
    Then("the system shall update the online count to {number}", (_ctx, count: number) => {
      expect(online()).toHaveLength(count);
    });
    And("the online list shall be {string}", (_ctx, list: string) => {
      expect(names()).toEqual(list.split(", "));
    });
    And("when {string} moves on to lab {number} the online count shall stay at {number} and show {string} at {string}", async (_ctx, name: string, n: number, count: number, who: string, title: string) => {
      await arrives(name, n);
      expect(online()).toHaveLength(count);
      expect(card(who)).toMatchObject({ title, loRoute: lab(n).route });
    });
  });

  Scenario("Express sentiment", ({ Given, When, Then, And }) => {
    Given("{string} has opened lab {number} of the course", opens);
    When("the student sets their sentiment to {string}", (_ctx, sentiment: string) => tutorsConnectService.updateSentiment(sentiment));
    And("the student moves on to lab {number}", (_ctx, n: number) => openLo(course, lab(n)));
    Then("the system shall store the sentiment {string} for {string}", async (_ctx, sentiment: string, login: string) => {
      expect(await backend.rows("tutors-connect-users")).toMatchObject([{ github_id: login, sentiment }]);
    });
    And("the system shall broadcast the sentiment {string} to other course participants", (_ctx, sentiment: string) => {
      const afterChange = broadcasts().filter((payload) => payload.loRoute === lab(2).route);
      // Once on the course topic, once on the all-courses topic the live app listens to.
      expect(afterChange.map((payload) => payload.user?.sentiment)).toEqual([sentiment, sentiment]);
    });
    And("the sentiment {string} shall be on the presence card of {string}", (_ctx, sentiment: string, name: string) => {
      expect(card(name)?.user?.sentiment).toBe(sentiment);
    });
  });

  Scenario("Private mode hides presence", ({ Given, When, Then, And }) => {
    Given("the student has disabled share presence", async () => {
      tutorsConnectService.toggleShare();
      await settle();
    });
    When("{string} opens lab {number} of the course", opens);
    Then("the system shall mark {string} as {string}", async (_ctx, login: string, status: string) => {
      expect(await backend.rows("tutors-connect-users")).toMatchObject([{ github_id: login, online_status: status }]);
    });
    And("the system shall not broadcast their activity to others", async () => {
      expect(broadcasts()).toEqual([]);
      expect(backend.publishedOn(course.courseId)).toEqual([]);
      expect(backend.publishedOn(ALL_COURSES_CHANNEL)).toEqual([]);
      expect(readerServer.posts).toEqual([]);
      expect(await backend.rows("tutors-connect-latest")).toEqual([]);
    });
    And("their name shall not appear in the online list", () => {
      // Activity controls are hidden while sharing is disabled, so there is no reader to deliver to.
      expect(presenceService.listeningTo).toBe("");
      expect(backend.streaming(course.courseId)).toHaveLength(0);
      expect(names()).toEqual([]);
    });
  });

  Rule("If a learning event is published for a course the student is not reading, then the reader shall not receive it.", ({ RuleScenario }) => {
    RuleScenario("Events from another course never reach the reader", ({ Given, When, Then, And }) => {
      Given("{string} has opened lab {number} of the course", opens);
      When("a learning event for the course {string} is published platform-wide", async (_ctx, otherCourseId: string) => {
        const other = publishedCourse(otherCourseId, 1);
        await loEventArrives(ALL_COURSES_CHANNEL, "Bob", other, labsOf(other)[0]);
      });
      Then("the online list shall be {string}", (_ctx, list: string) => {
        expect(names()).toEqual(list.split(", "));
      });
      // The guard itself: the reader never streams the platform topic (its server only publishes to it), so the
      // platform's events are never delivered to it.
      And("the reader shall hold no joined platform-wide channel", () => {
        expect(backend.streaming(ALL_COURSES_CHANNEL)).toEqual([]);
      });
    });

    RuleScenario("The reader still publishes platform-wide for the live dashboard", ({ Given, Then }) => {
      Given("{string} has opened lab {number} of the course", opens);
      Then("the platform-wide channel shall carry {number} event for {string}", (_ctx, count: number, name: string) => {
        const published = backend.publishedOn(ALL_COURSES_CHANNEL).map((message) => message.payload as LoRecord);
        expect(published.filter((payload) => payload.user?.fullName === name)).toHaveLength(count);
      });
    });
  });
});
