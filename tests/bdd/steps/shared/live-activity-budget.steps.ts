import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect, vi } from "vitest";

// The seams: the `pg` driver (the in-process store), the environments and SvelteKit. Everything
// between them is product code, the reader's server route and the realtime hub included.
vi.mock("pg", async () => (await import("../../support/backend.ts")).pgModule);
vi.mock("$app/env/public", async () => (await import("../../support/backend.ts")).publicEnv);
vi.mock("$app/env/private", async () => (await import("../../support/backend.ts")).privateEnv);
vi.mock("$app/env", () => ({ browser: true, goto: vi.fn() }));

import { freshBrowser, githubUser, labsOf, liveActivityStored, openLo, postToReaderServer, publishedCourse, readerServer, signIn } from "../../support/connect.ts";
import { backend, publicEnv } from "../../support/backend.ts";
import { apiRequests } from "../../support/reader-api.ts";
import type { Course } from "../../../../packages/jsr/model/src/tutors.ts";
import { configureAdapters } from "../../../../packages/adapters/driving/svelte-state/src/adapters.ts";
import { composeReader } from "../../../../apps/reader/src/lib/compose.ts";
import type { LoRecord } from "../../../../packages/adapters/driving/svelte-state/src/community/types.svelte.ts";
import { tutorsConnectService } from "../../../../packages/adapters/driving/svelte-state/src/connect/services/connect.svelte.ts";

const feature = await loadFeature("tests/bdd/features/shared/live-activity-budget.feature");

describeFeature(feature, ({ Background, Rule, AfterEachScenario }) => {
  let course: Course;
  let answer: { status: number; answer: unknown } | undefined;

  /** A learning event as the reader's browser builds it, for a client that posts directly. */
  const learningEvent = (name: string): Record<string, unknown> => {
    const user = githubUser(name);
    const lo = labsOf(course)[0];
    return {
      courseId: course.courseId,
      courseUrl: course.courseUrl,
      courseTitle: course.title,
      title: lo.title,
      loRoute: lo.route,
      type: lo.type,
      isPrivate: false,
      user: { fullName: user.name, avatar: user.image, id: user.login, sentiment: user.sentiment }
    };
  };
  /** What the reader's server published to Tutors Live on `topic` for `name`. */
  const broadcastsFor = (topic: string, name: string) => backend.publishedOn(topic).filter((message) => (message.payload as LoRecord).user?.fullName === name);

  const signedIn = async (_ctx: unknown, name: string, sharing: string) => {
    await signIn(githubUser(name));
    if (sharing === "disabled") tutorsConnectService.toggleShare();
  };
  const opensLab = (_ctx: unknown, n: number) => openLo(course, labsOf(course)[n - 1]);
  const courseFeedHas = (_ctx: unknown, count: number, name: string) => expect(broadcastsFor(course.courseId, name)).toHaveLength(count);
  const answers = (_ctx: unknown, status: number) => expect(answer?.status).toBe(status);
  const sendsFor = async (_ctx: unknown, name: string) => {
    answer = await postToReaderServer(JSON.stringify(learningEvent(name)));
  };

  AfterEachScenario(() => {
    publicEnv.PUBLIC_ANON_MODE = "FALSE";
  });

  Background(({ Given }) => {
    Given("the course {string} is published with {number} labs", async (_ctx, courseId: string, labCount: number) => {
      await freshBrowser();
      course = publishedCourse(courseId, labCount);
      answer = undefined;
    });
  });

  Rule(
    "When a student opens a learning object, the reader shall send the learning event to the reader's server without publishing it over Realtime from the browser.",
    ({ RuleScenario }) => {
      RuleScenario("A page view is stored and sent to the reader's server", ({ Given, When, Then, And }) => {
        Given("{string} is signed in with sharing {word}", signedIn);
        When("the student opens lab {number}", opensLab);
        Then("the reader's server has received {number} learning event for {string}", (_ctx, count: number, name: string) => {
          const received = readerServer.posts.filter((post) => (post.body as LoRecord).user?.fullName === name);
          expect(received).toHaveLength(count);
          expect(received[0].body).toMatchObject({ courseId: course.courseId, loRoute: labsOf(course)[0].route });
          expect(received[0].status).toBe(202);
        });
        And("the learning event of {string} is stored for Tutors Live", (_ctx, name: string) => {
          expect(liveActivityStored(name)).toEqual([expect.objectContaining({ courseId: course.courseId, loRoute: labsOf(course)[0].route })]);
        });
        // A browser publishes over Realtime only through POST /api/realtime/publish; it opened no stream
        // either. What the course and platform feeds carry is what the server published for its POST.
        And("the browser has published nothing over Realtime", () => {
          expect(apiRequests.filter((request) => request.url === "/api/realtime/publish")).toEqual([]);
          expect(backend.streams).toEqual([]);
          expect(broadcastsFor(course.courseId, "Alice")).toHaveLength(1);
        });
      });
    }
  );

  Rule(
    "If a learning event sent to the reader's server is larger than 4 KB, lacks a course or student id, or has a field over 1000 characters, then the reader shall reject it with status 400.",
    ({ RuleScenarioOutline }) => {
      RuleScenarioOutline("A malformed learning event is rejected and not published", ({ When, Then, And }, variables) => {
        When("a client sends the reader's server a learning event with {string}", async () => {
          const fault = String(variables.fault);
          const event = learningEvent("Alice");
          const faults: Record<string, () => string> = {
            "no course id": () => JSON.stringify({ ...event, courseId: undefined }),
            "no student id": () => JSON.stringify({ ...event, user: { ...(event.user as object), id: "" } }),
            "a 1001 letter title": () => JSON.stringify({ ...event, title: "x".repeat(1001) }),
            "a 5000 byte body": () => JSON.stringify({ ...event, img: "x".repeat(5000 - JSON.stringify(event).length) }),
            "a body that is not JSON": () => "{ not json"
          };
          answer = await postToReaderServer(faults[fault]());
        });
        Then("the reader's server answers with status {number}", answers);
        And("the course feed has {number} broadcasts for {string}", courseFeedHas);
      });
    }
  );

  Rule("Where anonymous mode is enabled, the reader shall accept learning events at its server without publishing them.", ({ RuleScenario }) => {
    RuleScenario("An anonymous deployment publishes nothing", ({ Given, When, Then, And }) => {
      Given("the reader runs in anonymous mode", () => {
        publicEnv.PUBLIC_ANON_MODE = "TRUE";
        // The composition root reads the mode once; the reader's server reads it on every request.
        configureAdapters(composeReader(publicEnv));
      });
      When("a client sends the reader's server a learning event for {string}", sendsFor);
      Then("the reader's server answers with status {number}", answers);
      And("the course feed has {number} broadcasts for {string}", courseFeedHas);
    });
    RuleScenario("A signed-in deployment publishes the event", ({ When, Then, And }) => {
      When("a client sends the reader's server a learning event for {string}", sendsFor);
      Then("the reader's server answers with status {number}", answers);
      And("the course feed has {number} broadcasts for {string}", courseFeedHas);
    });
  });
});
