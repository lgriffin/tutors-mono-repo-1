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
import type { HelpRequest } from "@tutors/domain/assistance";
import { createDataApi } from "@tutors/data-api";
import { assistanceTopic, realtimeHub } from "@tutors/realtime-valkey";
import { freshBrowser, githubUser, labsOf, publishedCourse } from "../../support/connect.ts";
import { READER_ORIGIN, readerRequest, setReaderSession } from "../../support/reader-api.ts";
import { privateEnv, publicEnv } from "../../support/supabase-recorder.ts";
import { readStream, type OpenStream } from "../../support/sse-stream.ts";
import { committedMigrations, pgliteDatabase } from "../../../support/postgres-store.ts";
import { migrate } from "@tutors/store-postgres";

const feature = await loadFeature("tests/bdd/features/shared/help-request-server.feature");

// Opened before any scenario stubs the browser's globals (PGlite would take a stubbed `window` for a browser).
const db = await pgliteDatabase();
database.sql = db.sql;

type Row = { state: string; learner_id: string; step_id: string; lab_route: string; kind: string; acknowledged_by: string | null };

describeFeature(feature, ({ Background, Rule, AfterEachScenario }) => {
  let course: Course;
  let response: Response;
  let stream: OpenStream | undefined;
  let answered: HelpRequest | null;
  const requests: Record<string, string> = {};

  const firstLab = () => labsOf(course)[0].route;
  /** Tutors Live's calls: the reader's data API from another origin, with the lecturer's session. */
  const live = () => createDataApi(undefined, READER_ORIGIN);
  const as = (name: string | null) => setReaderSession(name ? githubUser(name) : null);
  const rows = async () => (await db.sql.query<Row>(`SELECT state, learner_id, step_id, lab_route, kind, acknowledged_by FROM assistance_requests`)).rows;
  const answers = (_ctx: unknown, status: number) => expect(response.status).toBe(status);

  const ask = async (kind: string, stepId: string) => {
    response = await readerRequest("POST", "/api/assistance", { action: "request", courseId: course.courseId, labRoute: firstLab(), stepId, kind });
  };
  const browserAsks = async (_ctx: unknown, kind: string, stepId: string) => ask(kind, stepId);
  const hasAsked = async (_ctx: unknown, name: string, kind: string, stepId: string) => {
    as(name);
    await ask(kind, stepId);
    expect(response.status).toBe(201);
    requests[name] = ((await response.json()) as { request: HelpRequest }).request.id;
  };
  const signedIn = (_ctx: unknown, name: string) => as(name);
  const acknowledges = async (_ctx: unknown, actor: string, owner: string) => {
    as(actor);
    response = await readerRequest("POST", "/api/assistance", { action: "acknowledge", id: requests[owner] });
  };
  const holdsOne = async (_ctx: unknown, state: string, name: string, stepId: string, kind: string) => {
    expect(await rows()).toEqual([expect.objectContaining({ state, learner_id: name, step_id: stepId, lab_route: firstLab(), kind })]);
  };
  const streaming = async (_ctx: unknown, name: string, courseId: string) => {
    as(name);
    response = await fetch(`${READER_ORIGIN}/api/realtime/stream?topic=${encodeURIComponent(assistanceTopic(courseId))}`, { credentials: "include" });
    if (response.status !== 200) return;
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
    stream = readStream(response);
  };
  const heard = () => stream!.frames.map((f) => f.payload as { type: string; request: HelpRequest });
  const readsQueue = async (_ctx: unknown, courseId: string) => {
    response = await fetch(`${READER_ORIGIN}/api/assistance?courseId=${courseId}`, { credentials: "include" });
  };

  AfterEachScenario(async () => {
    await stream?.close();
    stream = undefined;
    database.down = false;
    privateEnv.DATA_STORE = "";
    privateEnv.PRIVATE_DATABASE_URL = "";
    publicEnv.PUBLIC_REALTIME = "";
    as(null);
    for (const key of Object.keys(requests)) delete requests[key];
    await vi.waitFor(() => expect(realtimeHub(undefined).subscribed()).toEqual([]));
  });

  Background(({ Given, And }) => {
    Given("the course {string} is published with {number} labs and {string} as its educator", async (_ctx, courseId: string, labs: number, educator: string) => {
      freshBrowser();
      course = publishedCourse(courseId, labs, {}, { educators: [educator], whitelist: [], students: [] });
      await db.sql.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
      await migrate(db.sql, committedMigrations());
    });
    And("the reader's server keeps help requests in Postgres and publishes realtime on Valkey", () => {
      privateEnv.DATA_STORE = "postgres";
      privateEnv.PRIVATE_DATABASE_URL = "postgres://tutors@db.invalid/tutors";
      publicEnv.PUBLIC_REALTIME = "valkey";
    });
  });

  Rule(
    "Tutors shall accept a help request, acknowledgement or resolution only on the reader's server from the signed-in actor, refusing a visitor who is not signed in with 401 and a student acting as the lecturer with 403.",
    ({ RuleScenario }) => {
      RuleScenario("A signed-in student's request is kept as theirs", ({ Given, When, Then, And }) => {
        Given("{string} is signed in to the reader", signedIn);
        When("the browser asks for help as {string} on the step {string} of the first lab", browserAsks);
        Then("the reader shall answer {number}", answers);
        And("Postgres shall hold one {string} help request by {string} at the step {string} of the first lab of kind {string}", holdsOne);
      });

      RuleScenario("A visitor who is not signed in is refused", ({ Given, When, Then, And }) => {
        Given("nobody is signed in to the reader", () => as(null));
        When("the browser asks for help as {string} on the step {string} of the first lab", browserAsks);
        Then("the reader shall answer {number}", answers);
        And("Postgres shall hold no help request", async () => expect(await rows()).toEqual([]));
      });

      RuleScenario("A student cannot acknowledge as the lecturer", ({ Given, And, When, Then }) => {
        Given("{string} has asked for help as {string} on the step {string} of the first lab", hasAsked);
        And("{string} is signed in to the reader", signedIn);
        When("the browser acknowledges the request of {string}", async (_ctx, owner: string) => {
          response = await readerRequest("POST", "/api/assistance", { action: "acknowledge", id: requests[owner] });
        });
        Then("the reader shall answer {number}", answers);
        And("Postgres shall hold one {string} help request by {string} at the step {string} of the first lab of kind {string}", holdsOne);
      });

      RuleScenario("The course's educator acknowledges from Tutors Live", ({ Given, And, When, Then }) => {
        Given("{string} has asked for help as {string} on the step {string} of the first lab", hasAsked);
        And("{string} is signed in to the reader", signedIn);
        When("Tutors Live acknowledges the request of {string} with the session", async (_ctx, owner: string) => {
          response = (await live().postHelp({ action: "acknowledge", id: requests[owner] }))!;
        });
        Then("the reader shall answer {number}", answers);
        And("Postgres shall hold one {string} help request by {string} at the step {string} of the first lab of kind {string}", holdsOne);
        And("the request shall record it was acknowledged by {string}", async (_ctx, name: string) => {
          expect((await rows())[0].acknowledged_by).toBe(name);
        });
      });
    }
  );

  Rule("When a help request changes state, tutors shall publish the changed request on the course's help queue topic once it is stored.", ({ RuleScenario }) => {
    RuleScenario("An educator watching the queue hears a request open and be acknowledged", ({ Given, And, When, Then }) => {
      Given("{string} is streaming the help queue of {string} from Tutors Live", streaming);
      And("{string} has asked for help as {string} on the step {string} of the first lab", hasAsked);
      When("{string} acknowledges the request of {string}", acknowledges);
      Then("the stream shall carry the request of {string} as {string}, then as {string}", async (_ctx, name: string, first: string, second: string) => {
        await vi.waitFor(() =>
          expect(heard().map((c) => [c.type, c.request.learnerId, c.request.state])).toEqual([
            ["help-request", name, first],
            ["help-request", name, second]
          ])
        );
      });
    });

    RuleScenario("A refused change publishes nothing", ({ Given, And, When, Then }) => {
      Given("{string} is streaming the help queue of {string} from Tutors Live", streaming);
      And("{string} has asked for help as {string} on the step {string} of the first lab", hasAsked);
      When("{string} acknowledges the request of {string}", acknowledges);
      Then("the stream shall carry the request of {string} as {string} and nothing more", async (_ctx, name: string, state: string) => {
        expect(response.status).toBe(403);
        await vi.waitFor(() => expect(heard().map((c) => [c.request.learnerId, c.request.state])).toEqual([[name, state]]));
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(heard()).toHaveLength(1);
      });
    });
  });

  Rule(
    "Tutors shall give a course's help queue, streamed or read, only to a signed-in educator of the course, and give a student only their own live request, read from stored rows.",
    ({ RuleScenario }) => {
      RuleScenario("The educator reads the queue from Tutors Live", ({ Given, And, When, Then }) => {
        let queue: Awaited<ReturnType<ReturnType<typeof live>["getHelpQueue"]>>;
        Given("{string} has asked for help as {string} on the step {string} of the first lab", hasAsked);
        And("{string} is signed in to the reader", signedIn);
        When("Tutors Live reads the help queue of {string} with the session", async (_ctx, courseId: string) => {
          queue = await live().getHelpQueue(courseId);
        });
        Then("the queue shall hold the request of {string} at the step {string} of the first lab", (_ctx, name: string, stepId: string) => {
          expect(queue?.queue.map((e) => [e.request.learnerId, e.request.ref.labRoute, e.request.ref.stepId, e.escalation])).toEqual([[name, firstLab(), stepId, "none"]]);
          expect(queue?.queue[0].waitingMs).toBeGreaterThanOrEqual(0);
        });
      });

      RuleScenario("A student cannot stream the queue", ({ Given, When, Then }) => {
        Given("{string} is signed in to the reader", signedIn);
        When("Tutors Live streams the help queue of {string} with the session", async (ctx, courseId: string) => streaming(ctx, "bob", courseId));
        Then("the reader shall answer {number}", answers);
      });

      RuleScenario("A student cannot read the queue", ({ Given, When, Then }) => {
        Given("{string} is signed in to the reader", signedIn);
        When("Tutors Live reads the help queue of {string} with the session", readsQueue);
        Then("the reader shall answer {number}", answers);
      });

      const readsOwn = async (_ctx: unknown, name: string, courseId: string) => {
        as(name);
        response = await readerRequest("GET", `/api/assistance/mine?courseId=${courseId}`);
        expect(response.status).toBe(200);
        answered = ((await response.json()) as { request: HelpRequest | null }).request;
      };

      RuleScenario("A student reads their own request", ({ Given, When, Then }) => {
        Given("{string} has asked for help as {string} on the step {string} of the first lab", hasAsked);
        When("{string} reads their own help request in {string}", readsOwn);
        Then("the answer shall be the request of {string} of kind {string}", (_ctx, name: string, kind: string) => {
          expect(answered).toMatchObject({ id: requests[name], learnerId: name, kind, state: "open" });
        });
      });

      RuleScenario("A student never reads another student's request", ({ Given, When, Then }) => {
        Given("{string} has asked for help as {string} on the step {string} of the first lab", hasAsked);
        When("{string} reads their own help request in {string}", readsOwn);
        Then("the answer shall be no request", () => expect(answered).toBeNull());
      });
    }
  );

  Rule(
    "If the assistance store is unreachable when a student asks for help, then tutors shall answer that the request was not sent, and record and publish nothing.",
    ({ RuleScenario }) => {
      RuleScenario("The database is down", ({ Given, And, When, Then }) => {
        Given("{string} is streaming the help queue of {string} from Tutors Live", streaming);
        And("the Postgres database is unreachable", () => {
          database.down = true;
        });
        And("{string} is signed in to the reader", signedIn);
        When("the browser asks for help as {string} on the step {string} of the first lab", browserAsks);
        Then("the reader shall answer {number} saying the help request was not sent", async (_ctx, status: number) => {
          expect(response.status).toBe(status);
          expect(((await response.json()) as { message: string }).message).toMatch(/not sent/);
          database.down = false;
          expect(await rows()).toEqual([]);
        });
        And("the stream shall carry nothing", async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          expect(stream!.frames).toEqual([]);
        });
      });
    }
  );
});
