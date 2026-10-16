/**
 * Lecturer feedback on the reader's server (Rules 0405, 0564, 0565): the reader's /api/feedback
 * routes over a Postgres database (PGlite) and the process's memory hub, which stands in for Valkey.
 */
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect, vi } from "vitest";

// The seams: Supabase (as the other reader-server features mock it), the environments, SvelteKit,
// and the `pg` driver, whose Pool is the PGlite database below, read on every query so a scenario
// can take the database down. With no PRIVATE_VALKEY_URL the reader's server publishes on the
// process's memory hub, which stands in for Valkey; everything between the routes and them is product code.
vi.mock("../../../../packages/adapters/driven/store-supabase/node_modules/@supabase/supabase-js/dist/index.mjs", async () => ({
  createClient: (await import("../../support/supabase-recorder.ts")).createClient
}));
vi.mock("@supabase/supabase-js", async () => ({ createClient: (await import("../../support/supabase-recorder.ts")).createClient }));
vi.mock("$app/env/public", async () => {
  const { publicEnv } = await import("../../support/supabase-recorder.ts");
  const { READER_ORIGIN } = await import("../../support/reader-api.ts");
  return Object.assign(publicEnv, { PUBLIC_READER_URL: READER_ORIGIN });
});
vi.mock("$app/env/private", async () => (await import("../../support/supabase-recorder.ts")).privateEnv);
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
import { READER_ORIGIN, readerRequest, setReaderSession } from "../../support/reader-api.ts";
import { privateEnv, publicEnv } from "../../support/supabase-recorder.ts";
import { readStream, type OpenStream } from "../../support/sse-stream.ts";
import { committedMigrations, pgliteDatabase } from "../../../support/postgres-store.ts";
import { migrate } from "@tutors/store-postgres";

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
    await stream?.close();
    stream = undefined;
    database.down = false;
    privateEnv.DATA_STORE = "";
    privateEnv.PRIVATE_DATABASE_URL = "";
    publicEnv.PUBLIC_REALTIME = "";
    as(null);
    await vi.waitFor(() => expect(realtimeHub(undefined).subscribed()).toEqual([]));
  });

  Background(({ Given, And }) => {
    Given("the course {string} is published with {number} labs and {string} as its educator", async (_ctx, courseId: string, labs: number, educator: string) => {
      freshBrowser();
      course = publishedCourse(courseId, labs, {}, { educators: [educator], whitelist: [], students: [] });
      await db.sql.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
      await migrate(db.sql, committedMigrations());
    });
    And("the reader's server keeps feedback in Postgres and publishes realtime on Valkey", () => {
      privateEnv.DATA_STORE = "postgres";
      privateEnv.PRIVATE_DATABASE_URL = "postgres://tutors@db.invalid/tutors";
      publicEnv.PUBLIC_REALTIME = "valkey";
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

  Rule("When an educator broadcasts an explanation, tutors shall send the course's students one toast naming the step and linking to it.", ({ RuleScenario }) => {
    RuleScenario("A student elsewhere in the course hears the toast", ({ Given, When, Then }) => {
      Given("{string} is streaming the course broadcasts of {string}", (_ctx, name: string, courseId: string) => streamTopic(name, noticeTopic(courseId, "course:broadcast")));
      When("{string} broadcasts {string} on the step {string} of the first lab", broadcasts);
      Then(
        "the broadcast stream shall carry one toast from {string} linking to the step {string} of the first lab and saying {string}",
        async (_ctx, sender: string, stepId: string, body: string) => {
          await vi.waitFor(() => expect(stream!.frames).toHaveLength(1));
          await settle();
          expect(stream!.frames.map((f) => f.payload)).toEqual([
            expect.objectContaining({
              type: "course:broadcast",
              courseId: course.courseId,
              senderName: sender,
              description: body,
              actionUrl: `${firstLab()}/${stepId}`,
              title: stepId
            })
          ]);
        }
      );
    });
  });
});
