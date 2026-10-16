import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect, vi } from "vitest";

// The seams: the `pg` driver (the in-process store), the environments, SvelteKit and the identity
// adapter. Everything between them is product code.
vi.mock("pg", async () => (await import("../../support/backend.ts")).pgModule);
vi.mock("$app/env/public", async () => (await import("../../support/backend.ts")).publicEnv);
// `$app/env` and `$app/navigation` are aliased to one stub file, so one mock serves both.
vi.mock("$app/env", () => ({ browser: true, goto: vi.fn() }));
vi.mock("$app/env/private", async () => (await import("../../support/backend.ts")).privateEnv);

import { freshBrowser, labsOf, loEventArrives, publishedCourse, studentOpensLab } from "../../support/connect.ts";
import { liveService } from "../../../../packages/adapters/driving/svelte-state/src/community/services/live.svelte.ts";
import { presenceService } from "../../../../packages/adapters/driving/svelte-state/src/community/services/presence.svelte.ts";

const feature = await loadFeature("tests/bdd/features/live/presence-tracking.feature");

const list = (csv: string) => csv.split(",").map((item) => item.trim());

describeFeature(feature, ({ Scenario }) => {
  Scenario("Display courses with active students", ({ Given, When, Then, And }) => {
    // The home page of the live app: one stream of the topic every reader's server publishes to.
    Given("I am viewing the live dashboard", async () => {
      await freshBrowser();
      await liveService.startGlobalPresenceService();
    });
    // Each student signs in to the reader and opens a lab; what reaches the dashboard is the reader's own broadcast.
    When("{number} students come online across the courses {string}", async (_ctx, count: number, courseIds: string) => {
      const courses = list(courseIds).map((courseId) => publishedCourse(courseId));
      for (let i = 0; i < count; i++) await studentOpensLab(`Student ${i + 1}`, courses[i % courses.length]);
    });
    Then("I should see {number} course cards, for {string}", (_ctx, count: number, courseIds: string) => {
      expect(liveService.coursesOnline.value).toHaveLength(count);
      expect(liveService.coursesOnline.value.map((lo) => lo.courseId)).toEqual(list(courseIds));
    });
    And("the dashboard should count {number} active students", (_ctx, count: number) => {
      expect(liveService.studentsOnline.value.map((lo) => lo.user?.fullName)).toEqual(Array.from({ length: count }, (_, i) => `Student ${i + 1}`));
    });
  });

  Scenario("Display individual student on a course", ({ Given, When, Then, And }) => {
    const course = publishedCourse("web-dev-101");
    // The course page of the live app listens through the presence service, on the topic of that course.
    Given("I am viewing the course detail for {string}", async (_ctx, courseId: string) => {
      await freshBrowser();
      await presenceService.startPresenceListener(courseId);
    });
    When("a student {string} becomes active on {string}", async (_ctx, name: string, courseId: string) => {
      await loEventArrives(courseId, name, course, labsOf(course)[0]);
    });
    Then("I should see {string} in the active students list", (_ctx, name: string) => {
      expect(presenceService.studentsOnline.value.map((lo) => lo.user?.fullName)).toEqual([name]);
    });
    And("I should see their avatar {string}", (_ctx, avatar: string) => {
      expect(presenceService.studentsOnline.value[0].user?.avatar).toBe(avatar);
    });
  });
});
