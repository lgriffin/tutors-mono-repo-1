/**
 * Lecturer feedback on the reader's server (Rules 0405, 0564, 0565, 0567): the reader's /api/feedback
 * routes over a Postgres database (PGlite) and the process's memory hub, which stands in for Valkey.
 */
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect, vi } from "vitest";

// The seams: the environments (a signed-in deployment, backend.ts), SvelteKit, and the `pg`
// driver, whose Pool is the PGlite database below, read on every query so a scenario
// can take the database down. With no PRIVATE_VALKEY_URL the reader's server publishes on the
// process's memory hub, which stands in for Valkey; everything between the routes and them is product code.
vi.mock("$app/env/public", async () => {
  const { publicEnv } = await import("../../support/backend.ts");
  const { READER_ORIGIN } = await import("../../support/reader-api.ts");
  return Object.assign(publicEnv, { PUBLIC_READER_URL: READER_ORIGIN });
});
vi.mock("$app/env/private", async () => (await import("../../support/backend.ts")).privateEnv);
vi.mock("$app/env", () => ({ browser: true, building: false, goto: vi.fn() }));
const database = vi.hoisted(() => ({ sql: undefined as unknown, down: false }));
vi.mock("pg", () => {
  class Pool {
    query(...args: unknown[]) {
      if (database.down) return Promise.reject(new Error("connect ECONNREFUSED"));
      return (database.sql as { query: (...a: unknown[]) => unknown }).query(...args);
    }
    end() {
      return Promise.resolve();
    }
    on() {
      return this;
    }
  }
  return { Pool, default: { Pool } };
});

import type { Course } from "../../../../packages/jsr/model/src/tutors.ts";
import type { Annotation } from "@tutors/domain/feedback";
import { assistanceTopic, noticeTopic, realtimeHub } from "@tutors/realtime-valkey";
import { freshBrowser, githubUser, labsOf, publishedCourse } from "../../support/connect.ts";
import { READER_ORIGIN, readerRequest, serveCourseJson, setReaderSession } from "../../support/reader-api.ts";
import { readStream, type OpenStream } from "../../support/sse-stream.ts";
import { committedMigrations, pgliteDatabase } from "../../../support/postgres-store.ts";
import { migrate } from "@tutors/store-postgres";
import { createBroadcastLimiter } from "@tutors/application";
import { broadcastLimiter } from "../../../../apps/reader/src/lib/server/snippets.ts";

const feature = await loadFeature("tests/bdd/features/shared/feedback-server.feature");

// Opened before any scenario stubs the browser's globals (PGlite would take a stubbed `window` for a browser).
const db = await pgliteDatabase();
database.sql = db.sql;

type Row = { author_id: string; audience: string; learner_id: string | null; step_id: string; lab_route: string; body: string };

describeFeature(feature, ({ Background, Rule, AfterEachScenario }) => {
  let course: Course;
  let response: Response;
  let stream: OpenStream | undefined;

  const firstLab = () => labsOf(course)[0].route;
  const as = (name: string | null) => setReaderSession(name ? githubUser(name) : null);
  const rows = async () => (await db.sql.query<Row>(`SELECT author_id, audience, learner_id, step_id, lab_route, body FROM feedback_annotations`)).rows;
  const answers = (_ctx: unknown, status: number) => expect(response.status).toBe(status);
  const signedIn = (_ctx: unknown, name: string) => as(name);
  const step = (stepId: string) => ({ courseId: course.courseId, labRoute: firstLab(), stepId });

  const browserBroadcasts = async (_ctx: unknown, body: string, stepId: string) => {
    response = await readerRequest("POST", "/api/feedback", { action: "broadcast", ...step(stepId), body });
  };
  const broadcasts = async (_ctx: unknown, name: string, body: string, stepId: string) => {
    as(name);
    await browserBroadcasts(_ctx, body, stepId);
    expect(response.status).toBe(201);
  };
  const writes = async (_ctx: unknown, name: string, body: string, learnerId: string, stepId: string) => {
    as(name);
    response = await readerRequest("POST", "/api/feedback", { action: "annotate", ...step(stepId), learnerId, body });
    expect(response.status).toBe(201);
  };
  const streamTopic = async (name: string, topic: string) => {
    as(name);
    response = await fetch(`${READER_ORIGIN}/api/realtime/stream?topic=${encodeURIComponent(topic)}`, { credentials: "include" });
    expect(response.status).toBe(200);
    stream = readStream(response);
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  AfterEachScenario(async () => {
    // Each scenario starts with no toast sent on the course this minute.
    Object.assign(broadcastLimiter, createBroadcastLimiter());
    await stream?.close();
    stream = undefined;
    database.down = false;
    as(null);
    await vi.waitFor(() => expect(realtimeHub(undefined).subscribed()).toEqual([]));
  });

  Background(({ Given }) => {
    Given("the course {string} is published with {number} labs and {string} as its educator", async (_ctx, courseId: string, labs: number, educator: string) => {
      await freshBrowser();
      course = publishedCourse(courseId, labs, {}, { educators: [educator], whitelist: [], students: [] });
      await db.sql.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
      await migrate(db.sql, committedMigrations());
    });
  });

  Rule(
    "Tutors shall keep and change lecturer feedback only on the reader's server as the signed-in actor, refusing a visitor who is not signed in with 401, and give a student only the broadcasts and the annotations addressed to them.",
    ({ RuleScenario }) => {
      RuleScenario("The educator's broadcast is kept as theirs", ({ Given, When, Then, And }) => {
        Given("{string} is signed in to the reader", signedIn);
        When("the browser broadcasts {string} on the step {string} of the first lab", browserBroadcasts);
        Then("the reader shall answer {number}", answers);
        And("Postgres shall hold one annotation by {string} for {string} at the step {string} of the first lab", async (_ctx, author: string, audience: string, stepId: string) => {
          expect(await rows()).toEqual([expect.objectContaining({ author_id: author, audience, learner_id: null, step_id: stepId, lab_route: firstLab() })]);
        });
      });

      RuleScenario("A visitor who is not signed in is refused", ({ Given, When, Then, And }) => {
        Given("nobody is signed in to the reader", () => as(null));
        When("the browser broadcasts {string} on the step {string} of the first lab", browserBroadcasts);
        Then("the reader shall answer {number}", answers);
        And("Postgres shall hold no annotation", async () => expect(await rows()).toEqual([]));
      });

      RuleScenario("A student reads the broadcast and their own annotation, never another student's", ({ Given, And, When, Then }) => {
        Given("{string} has written {string} to {string} on the step {string} of the first lab", writes);
        And("{string} has written {string} to {string} on the step {string} of the first lab", writes);
        And("{string} has broadcast {string} on the step {string} of the first lab", broadcasts);
        When("{string} reads the step {string} of the first lab", async (_ctx, name: string, stepId: string) => {
          as(name);
          const s = step(stepId);
          response = await readerRequest("GET", `/api/feedback?${new URLSearchParams(s)}`);
        });
        Then("the reader shall answer with the broadcast {string} and the annotation {string} only", async (_ctx, broadcast: string, personal: string) => {
          expect(response.status).toBe(200);
          const read = (await response.json()) as { broadcasts: Annotation[]; personal: Annotation[]; history: unknown };
          expect(read.broadcasts.map((a) => a.body)).toEqual([broadcast]);
          expect(read.personal.map((a) => a.body)).toEqual([personal]);
          expect(read.history).toBeNull();
        });
      });
    }
  );

  Rule(
    "When an educator broadcasts an explanation, tutors shall publish one annotation event on the course's help queue topic to the Tutors Live tabs watching it.",
    ({ RuleScenario }) => {
      const watching = (_ctx: unknown, name: string, courseId: string) => streamTopic(name, assistanceTopic(courseId));
      RuleScenario("Tutors Live hears the explanation once", ({ Given, When, Then }) => {
        Given("{string} is streaming the help queue of {string} from Tutors Live", watching);
        When("{string} broadcasts {string} on the step {string} of the first lab", broadcasts);
        Then("the stream shall carry one annotation for {string} saying {string}", async (_ctx, audience: string, body: string) => {
          await vi.waitFor(() => expect(stream!.frames).toHaveLength(1));
          await settle();
          const change = stream!.frames.map((f) => f.payload as { type: string; annotation: Annotation });
          expect(change.map((c) => [c.type, c.annotation.audience.kind, c.annotation.body])).toEqual([["annotation", audience, body]]);
        });
      });
      RuleScenario("A personal annotation is not announced", ({ Given, When, Then }) => {
        Given("{string} is streaming the help queue of {string} from Tutors Live", watching);
        When("{string} has written {string} to {string} on the step {string} of the first lab", writes);
        Then("the stream shall carry nothing", async () => {
          await settle();
          expect(stream!.frames).toEqual([]);
        });
      });
    }
  );

  Rule(
    "When an educator broadcasts an explanation, tutors shall send the course's students one toast naming the step and linking to it, without the explanation's text, and no more than one toast a minute on the course.",
    ({ RuleScenario }) => {
      const streaming = (_ctx: unknown, name: string, courseId: string) => streamTopic(name, noticeTopic(courseId, "course:broadcast"));
      const oneToast = async (_ctx: unknown, sender: string, stepId: string) => {
        await vi.waitFor(() => expect(stream!.frames).toHaveLength(1));
        await settle();
        expect(stream!.frames.map((f) => f.payload)).toEqual([
          expect.objectContaining({ type: "course:broadcast", courseId: course.courseId, senderName: sender, actionUrl: `${firstLab()}/${stepId}`, title: stepId })
        ]);
      };

      RuleScenario("A student elsewhere in the course hears the toast", ({ Given, When, Then, And }) => {
        Given("{string} is streaming the course broadcasts of {string}", streaming);
        When("{string} broadcasts {string} on the step {string} of the first lab", broadcasts);
        Then("the broadcast stream shall carry one toast from {string} linking to the step {string} of the first lab", oneToast);
        And("the toast shall not carry {string}", (_ctx, body: string) => expect(JSON.stringify(stream!.frames)).not.toContain(body));
      });

      RuleScenario("A second explanation within the minute is not toasted again", ({ Given, When, And, Then }) => {
        Given("{string} is streaming the course broadcasts of {string}", streaming);
        When("{string} broadcasts {string} on the step {string} of the first lab", broadcasts);
        And("{string} broadcasts {string} on the step {string} of the first lab", broadcasts);
        Then("the broadcast stream shall carry one toast from {string} linking to the step {string} of the first lab", oneToast);
        And("Postgres shall hold {int} annotations for {string}", async (_ctx, count: number, audience: string) =>
          expect((await rows()).filter((r) => r.audience === audience)).toHaveLength(count)
        );
      });
    }
  );

  Rule(
    "If a signed-in reader is not admitted to a private course, then the reader shall refuse with 403 to read feedback there or keep a reflection from them on its server.",
    ({ RuleScenario }) => {
      const privateCourse = (_ctx: unknown, courseId: string, student: string, educator: string) => {
        const enrollment = { educators: [educator], whitelist: [student], students: [] };
        course = publishedCourse(courseId, 2, {}, enrollment);
        serveCourseJson(courseId, { authLevel: 1, enrollment });
      };
      const readsStep = async (_ctx: unknown, name: string, stepId: string) => {
        as(name);
        response = await readerRequest("GET", `/api/feedback?${new URLSearchParams(step(stepId))}`);
      };
      RuleScenario("An outsider reads nothing from a private course", ({ Given, And, When, Then }) => {
        Given("the private course {string} admits {string} and is taught by {string}", privateCourse);
        And("{string} has broadcast {string} on the step {string} of the first lab", broadcasts);
        When("{string} reads the step {string} of the first lab", readsStep);
        Then("the reader shall answer {number}", answers);
      });
      RuleScenario("An outsider cannot plant a reflection in a private course", ({ Given, When, Then, And }) => {
        Given("the private course {string} admits {string} and is taught by {string}", privateCourse);
        When("{string} shares the note {string} on the step {string} of the first lab", async (_ctx, name: string, body: string, stepId: string) => {
          as(name);
          response = await readerRequest("POST", "/api/feedback", { action: "reflect", ...step(stepId), kind: "reflection", body });
        });
        Then("the reader shall answer {number}", answers);
        And("Postgres shall hold no reflection", async () => expect((await db.sql.query(`SELECT id FROM feedback_reflections`)).rows).toEqual([]));
      });
      RuleScenario("A student on the whitelist reads the course's feedback", ({ Given, And, When, Then }) => {
        Given("the private course {string} admits {string} and is taught by {string}", privateCourse);
        And("{string} has broadcast {string} on the step {string} of the first lab", broadcasts);
        When("{string} reads the step {string} of the first lab", readsStep);
        Then("the reader shall answer {number}", answers);
      });
    }
  );
});
