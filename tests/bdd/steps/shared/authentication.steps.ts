import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect, vi } from "vitest";

// The seams: the `pg` driver (the in-process store), the environments, SvelteKit and the injected
// identity client. Everything between them is product code.
vi.mock("pg", async () => (await import("../../support/backend.ts")).pgModule);
vi.mock("$app/env/public", async () => (await import("../../support/backend.ts")).publicEnv);
// `$app/env` and `$app/navigation` are aliased to one stub file, so one mock serves both.
vi.mock("$app/env", () => ({ browser: true, goto: vi.fn() }));
// The application injects this client into connect.
vi.mock("$app/env/private", async () => (await import("../../support/backend.ts")).privateEnv);
const authSignIn = vi.hoisted(() => vi.fn());

import { goto } from "$app/navigation";
import { ALL_COURSES_CHANNEL, freshBrowser, githubUser, labsOf, openLo, publishedCourse, readerServer, signIn } from "../../support/connect.ts";
import { backend } from "../../support/backend.ts";
import { apiRequests } from "../../support/reader-api.ts";
import type { Course } from "../../../../packages/jsr/model/src/tutors.ts";
import { tutorsConnectService } from "../../../../packages/adapters/driving/svelte-state/src/connect/services/connect.svelte.ts";
import { tutorsId } from "../../../../packages/adapters/driving/svelte-state/src/index.svelte.ts";

const feature = await loadFeature("tests/bdd/features/shared/authentication.feature");

describeFeature(feature, ({ Background, Rule }) => {
  let course: Course;

  const lab = () => labsOf(course)[0];
  const notAuthenticated = () => expect(tutorsId.value).toBeNull();
  const navigateToLab = (_ctx: unknown, courseId: string) => {
    expect(course.courseId).toBe(courseId);
    return openLo(course, lab());
  };
  const activityNotRecorded = async () => {
    expect(await backend.rows("learning_records")).toEqual([]);
    expect(await backend.rows("calendar")).toEqual([]);
    expect(await backend.rows("tutors-connect-latest")).toEqual([]);
    expect([...backend.publishedOn(course.courseId), ...backend.publishedOn(ALL_COURSES_CHANNEL)]).toEqual([]);
    expect(apiRequests.filter((request) => request.method === "POST" && ["/api/analytics", "/api/presence"].includes(request.url))).toEqual([]);
    expect(readerServer.posts).toEqual([]);
  };

  Background(({ Given }) => {
    Given("the course {string} is published with {number} labs", async (_ctx, courseId: string, labCount: number) => {
      await freshBrowser();
      tutorsConnectService.identityClient = { signIn: authSignIn, signOut: vi.fn() };
      course = publishedCourse(courseId, labCount);
    });
  });

  Rule(
    "When a student chooses to sign in from a course, the reader shall start the GitHub sign-in flow, return the student to that course and save the student's record.",
    ({ RuleScenario }) => {
      RuleScenario("Sign in with GitHub OAuth", ({ Given, When, Then, And }) => {
        Given("I am not authenticated", notAuthenticated);
        When("I choose to sign in from {string}", (_ctx, path: string) => tutorsConnectService.connect(path));
        Then("the reader should start the {string} sign-in flow, returning to {string}", (_ctx, provider: string, path: string) => {
          expect(provider).toBe("github");
          expect(authSignIn.mock.calls).toEqual([[path]]);
        });
        // The identity adapter owns the GitHub round trip; the reader takes over again when the session arrives.
        And("after authentication as {string} the reader should know me by my profile name {string}", async (_ctx, user: string, name: string) => {
          await signIn(githubUser(user));
          expect(tutorsId.value?.name).toBe(name);
        });
        And("my student record should be saved as {string} with the name {string}", async (_ctx, login: string, name: string) => {
          expect(await backend.rows("tutors-connect-users")).toMatchObject([{ github_id: login, full_name: name, avatar_url: githubUser(name).image }]);
        });
      });
    }
  );

  Rule("While a student is signed in, the reader shall record the student's lab visits in the analytics service.", ({ RuleScenario }) => {
    RuleScenario("Track authenticated user activity", ({ Given, When, Then, And }) => {
      Given("I am authenticated as {string}", (_ctx, name: string) => signIn(githubUser(name)));
      When("I navigate to a lab in {string}", navigateToLab);
      Then("my activity should be recorded to the analytics service", async () => {
        expect(await backend.rows("learning_records")).toHaveLength(1);
        expect(await backend.rows("calendar")).toHaveLength(1);
      });
      And("the record should include my user ID {string} and the lab route", async (_ctx, login: string) => {
        expect((await backend.rows("learning_records"))[0]).toMatchObject({ course_id: course.courseId, student_id: login, lo_id: lab().route, type: "lab", count: 1 });
        expect((await backend.rows("calendar"))[0]).toMatchObject({ studentid: login, courseid: course.courseId, pageloads: 1 });
      });
    });

    RuleScenario("Anonymous browsing records no activity", ({ Given, When, Then }) => {
      Given("I am not authenticated", notAuthenticated);
      When("I navigate to a lab in {string}", navigateToLab);
      Then("my activity should not be recorded", activityNotRecorded);
    });
  });

  Rule("The reader shall show course content without requiring a student to sign in.", ({ RuleScenario }) => {
    RuleScenario("Anonymous browsing", ({ Given, When, Then }) => {
      Given("I am not authenticated", notAuthenticated);
      When("I navigate to a lab in {string}", navigateToLab);
      Then("I should be able to view course content without being sent to sign in", () => {
        expect(goto).not.toHaveBeenCalled();
      });
    });
  });
});
