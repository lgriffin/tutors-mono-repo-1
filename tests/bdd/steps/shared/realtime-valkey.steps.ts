import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect, vi } from "vitest";

// The seams: Supabase (as the other reader-server features mock it), the environments and SvelteKit.
// With no PRIVATE_VALKEY_URL the servers share the process's memory hub, which stands in for Valkey;
// everything between the routes and the hub is product code.
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

import type { Course } from "../../../../packages/jsr/model/src/tutors.ts";
import { createRealtimeGateway, topics, type Subscription } from "@tutors/realtime";
import { playgroundTopic, realtimeHub, sseRealtimeAdapter, type EventSourceLike } from "@tutors/realtime-valkey";
import { GET as liveStream } from "../../../../apps/live/src/routes/api/realtime/stream/+server.ts";
import { freshBrowser, githubUser, labsOf, publishedCourse, signIn } from "../../support/connect.ts";
import { readerRequest, setReaderSession } from "../../support/reader-api.ts";
import { publicEnv, recorder } from "../../support/supabase-recorder.ts";

const feature = await loadFeature("tests/bdd/features/shared/realtime-valkey.feature");

type Frame = { event: string; payload: unknown; from?: string };

/** A browser reading a server-sent event stream: every `data:` frame it has received, parsed. */
type OpenStream = { response: Response; frames: Frame[]; close(): Promise<void> };

function readStream(response: Response): OpenStream {
  const frames: Frame[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      buffered += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffered.indexOf("\n\n")) >= 0) {
        const block = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        for (const line of block.split("\n")) if (line.startsWith("data: ")) frames.push(JSON.parse(line.slice(6)) as Frame);
      }
    }
  })();
  return { response, frames, close: () => reader.cancel() };
}

/** A fake EventSource per stream a tab opens, so a scenario can fail one. */
class FakeEventSource implements EventSourceLike {
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {}
  close() {
    this.closed = true;
  }
}

describeFeature(feature, ({ Background, Rule, AfterEachScenario }) => {
  let course: Course;
  let response: Response;
  const streams: Record<string, OpenStream> = {};
  let sources: FakeEventSource[] = [];
  let tabSubscription: Subscription | undefined;

  const hub = () => realtimeHub(undefined);
  const firstLab = () => labsOf(course)[0];
  const playground = () => playgroundTopic(course.courseId, firstLab().route);
  const learningEvent = (name: string) => {
    const user = githubUser(name);
    const lo = firstLab();
    return {
      courseId: course.courseId,
      courseUrl: course.courseUrl,
      courseTitle: course.title,
      title: lo.title,
      loRoute: lo.route,
      type: lo.type,
      isPrivate: false,
      user: { fullName: user.name, avatar: user.image, id: user.login }
    };
  };
  const streamFromReader = async (name: string, topic: string) => {
    response = await readerRequest("GET", `/api/realtime/stream?topic=${encodeURIComponent(topic)}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    streams[name] = readStream(response);
  };
  const deployed = (_ctx: unknown, realtime: string) => {
    publicEnv.PUBLIC_REALTIME = realtime;
  };
  const postsLearningEvent = async (_ctx: unknown, name: string) => {
    response = await readerRequest("POST", "/api/live/activity", learningEvent(name));
  };
  const receivesEventOf = (stream: string) => async (_ctx: unknown, name: string) => {
    await vi.waitFor(() => expect(streams[stream].frames.map((f) => [f.event, (f.payload as { user?: { fullName?: string } }).user?.fullName])).toEqual([["lo-event", name]]));
  };
  const receivesNothing = (stream: string) => async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(streams[stream].frames).toEqual([]);
  };
  const answers = (_ctx: unknown, status: number) => expect(response.status).toBe(status);
  /** The browser of `name` (null: signed out) sends the request; the reader sees its session. */
  const as = (name: string | null) => setReaderSession(name ? githubUser(name) : null);
  const publishes = async (name: string | null, event: string, topic: string, studentId = name ?? "") => {
    as(name);
    response = await readerRequest("POST", "/api/realtime/publish", { topic, event, payload: { studentId, files: [] }, from: "tab-1" });
  };

  AfterEachScenario(async () => {
    for (const stream of Object.values(streams)) await stream.close();
    for (const key of Object.keys(streams)) delete streams[key];
    await tabSubscription?.close();
    tabSubscription = undefined;
    sources = [];
    publicEnv.PUBLIC_REALTIME = "";
    as(null);
    vi.useRealTimers();
    // The hub lives as long as the server process, as in production: closing the streams unsubscribed them.
    await vi.waitFor(() => expect(hub().subscribed()).toEqual([]));
  });

  Background(({ Given }) => {
    Given("the course {string} is published with {number} labs and {string} as its educator", (_ctx, courseId: string, labs: number, educator: string) => {
      freshBrowser();
      course = publishedCourse(courseId, labs, {}, { educators: [educator], whitelist: [], students: [] });
    });
  });

  Rule(
    "Where a server is deployed with PUBLIC_REALTIME set to valkey, the reader shall publish each learning event it receives to the course's and the platform's activity topics on Valkey, without claiming the day's Live budget.",
    ({ RuleScenario }) => {
      RuleScenario("A page view reaches the course and platform feeds on a Valkey deployment", ({ Given, And, When, Then }) => {
        Given("the reader's server is deployed with PUBLIC_REALTIME {string}", deployed);
        And("a browser streams the activity of {string} from the reader", (_ctx, courseId: string) => streamFromReader("course", topics.courseActivity(courseId)));
        And("a browser streams the platform's activity from the reader", () => streamFromReader("platform", topics.platformActivity()));
        When("the reader posts the learning event of {string} opening the first lab", postsLearningEvent);
        Then("the reader answers 202 with the tier {string} and both activity topics", async (_ctx, tier: string) => {
          expect(response.status).toBe(202);
          expect(await response.json()).toEqual({ tier, topics: [course.courseId, topics.platformActivity()] });
        });
        And("the course stream receives the learning event of {string}", receivesEventOf("course"));
        And("the platform stream receives the learning event of {string}", receivesEventOf("platform"));
        And("no database function was called", () => expect(recorder.rpcCalls).toEqual([]));
      });

      RuleScenario("A page view on a deployment without PUBLIC_REALTIME is claimed against the budget", ({ Given, When, Then }) => {
        Given("the reader's server is deployed with PUBLIC_REALTIME {string}", deployed);
        When("the reader posts the learning event of {string} opening the first lab", postsLearningEvent);
        Then("the reader claimed the day's Live budget for {string}", (_ctx, courseId: string) => {
          expect(response.status).toBe(202);
          expect(recorder.rpcCalls.map((call) => [call.fn, call.args])).toContainEqual(["realtime_claim_live_publish", { p_course_id: courseId }]);
          expect(hub().subscribed()).toEqual([]);
        });
      });
    }
  );

  Rule(
    "When a browser opens the realtime stream of a topic on the reader's or Tutors Live's server, tutors shall send each message published to that topic as a server-sent event until the browser closes the stream.",
    ({ RuleScenario }) => {
      RuleScenario("A lecturer's broadcast reaches a reader tab's stream", ({ Given, And, When, Then }) => {
        Given("the reader's server is deployed with PUBLIC_REALTIME {string}", deployed);
        And("{string} is signed in to the reader", (_ctx, name: string) => signIn(githubUser(name)));
        And("a browser streams the broadcasts of {string} from the reader", (_ctx, courseId: string) => streamFromReader("broadcast", topics.courseBroadcasts(courseId)));
        When("{string} broadcasts {string} to {string}", async (_ctx, _name: string, title: string, courseId: string) => {
          response = await readerRequest("POST", "/api/notices", { courseId, title, description: "Head to the second lab" });
          expect(response.status).toBe(202);
        });
        Then("the broadcast stream receives the broadcast {string}", async (_ctx, title: string) => {
          await vi.waitFor(() =>
            expect(streams.broadcast.frames).toEqual([
              { event: "course-broadcast", payload: expect.objectContaining({ type: "course:broadcast", courseId: course.courseId, title, senderName: "eve" }) }
            ])
          );
        });
      });

      RuleScenario("Tutors Live's server streams what the reader's server published", ({ Given, And, When, Then }) => {
        Given("the reader's server is deployed with PUBLIC_REALTIME {string}", deployed);
        And("Tutors Live's server is deployed with PUBLIC_REALTIME {string}", deployed);
        And("a Live tab streams the activity of {string} from Tutors Live's server", async (_ctx, courseId: string) => {
          const url = new URL(`https://live.test/api/realtime/stream?topic=${encodeURIComponent(courseId)}`);
          const request = new Request(url);
          const answer = await liveStream({ request, url } as Parameters<typeof liveStream>[0]);
          expect(answer.status).toBe(200);
          streams.live = readStream(answer);
        });
        When("the reader posts the learning event of {string} opening the first lab", postsLearningEvent);
        Then("the Live tab's stream receives the learning event of {string}", receivesEventOf("live"));
      });

      RuleScenario("A closed stream receives nothing more", ({ Given, And, When, Then }) => {
        Given("the reader's server is deployed with PUBLIC_REALTIME {string}", deployed);
        And("a browser streams the activity of {string} from the reader", (_ctx, courseId: string) => streamFromReader("course", topics.courseActivity(courseId)));
        When("the browser closes the stream", async () => {
          expect(hub().subscribed()).toEqual([course.courseId]);
          await streams.course.close();
        });
        And("the reader posts the learning event of {string} opening the first lab", postsLearningEvent);
        Then("nothing listens to the activity of {string} any more", async (_ctx, courseId: string) => {
          await vi.waitFor(() => expect(hub().subscribed()).not.toContain(courseId));
          expect(streams.course.frames).toEqual([]);
        });
      });
    }
  );

  Rule("If a browser asks for the realtime stream of a topic Tutors does not publish, then the reader shall answer 400 and subscribe to nothing.", ({ RuleScenario }) => {
    RuleScenario("An unknown topic is refused", ({ Given, When, Then, And }) => {
      Given("the reader's server is deployed with PUBLIC_REALTIME {string}", deployed);
      When("a browser asks the reader for the stream of the topic {string}", async (_ctx, topic: string) => {
        response = await readerRequest("GET", `/api/realtime/stream?topic=${encodeURIComponent(topic)}`);
      });
      Then("the reader answers {number}", answers);
      And("nothing listens to the topic {string}", () => expect(hub().subscribed()).toEqual([]));
    });
  });

  Rule(
    "If a browser asks the reader's server to publish to a topic other than a playground share, an event other than a share's state or a lecturer's watching, or as anyone but the signed-in student or educator the event needs, then the reader shall answer 400, 401 or 403 and publish nothing.",
    ({ RuleScenario }) => {
      const streamsPlayground = (_ctx: unknown, name: string) => {
        as(name);
        return streamFromReader("playground", playground());
      };
      const publishesOnPlayground = (_ctx: unknown, name: string, event: string, studentId: string) => publishes(name, event, playground(), studentId);

      RuleScenario("A browser cannot publish a lecturer's broadcast", ({ Given, And, When, Then }) => {
        Given("the reader's server is deployed with PUBLIC_REALTIME {string}", deployed);
        And("{string} streams the broadcasts of {string} from the reader", (_ctx, name: string, courseId: string) => {
          as(name);
          return streamFromReader("broadcast", topics.courseBroadcasts(courseId));
        });
        When("{string} asks the reader to publish {string} on {string}", (_ctx, name: string, event: string, topic: string) => publishes(name, event, topic));
        Then("the reader answers {number}", answers);
        And("the broadcast stream receives nothing", receivesNothing("broadcast"));
      });

      RuleScenario("A playground share's state reaches the lecturer's stream", ({ Given, And, When, Then }) => {
        Given("the reader's server is deployed with PUBLIC_REALTIME {string}", deployed);
        And("{string} streams the playground share of the first lab of {string} from the reader", streamsPlayground);
        When("{string} asks the reader to publish {string} for {string} on the playground share of the first lab", publishesOnPlayground);
        Then("the reader answers {number}", answers);
        And("the playground stream receives the state of {string}", async (_ctx, studentId: string) => {
          await vi.waitFor(() => expect(streams.playground.frames).toEqual([{ event: "state", payload: { studentId, files: [] }, from: "tab-1" }]));
        });
      });

      RuleScenario("A browser cannot publish another event on a playground share", ({ Given, And, When, Then }) => {
        Given("the reader's server is deployed with PUBLIC_REALTIME {string}", deployed);
        And("{string} streams the playground share of the first lab of {string} from the reader", streamsPlayground);
        When("{string} asks the reader to publish {string} for {string} on the playground share of the first lab", publishesOnPlayground);
        Then("the reader answers {number}", answers);
        And("the playground stream receives nothing", receivesNothing("playground"));
      });

      RuleScenario("A signed-out browser cannot publish", ({ Given, And, When, Then }) => {
        Given("the reader's server is deployed with PUBLIC_REALTIME {string}", deployed);
        And("{string} streams the playground share of the first lab of {string} from the reader", streamsPlayground);
        When("a signed-out browser asks the reader to publish {string} for {string} on the playground share of the first lab", (_ctx, event: string, studentId: string) =>
          publishes(null, event, playground(), studentId)
        );
        Then("the reader answers {number}", answers);
        And("the playground stream receives nothing", receivesNothing("playground"));
      });

      RuleScenario("A student cannot share another student's work", ({ Given, And, When, Then }) => {
        Given("the reader's server is deployed with PUBLIC_REALTIME {string}", deployed);
        And("{string} streams the playground share of the first lab of {string} from the reader", streamsPlayground);
        When("{string} asks the reader to publish {string} for {string} on the playground share of the first lab", publishesOnPlayground);
        Then("the reader answers {number}", answers);
        And("the playground stream receives nothing", receivesNothing("playground"));
      });

      RuleScenario("A student cannot announce they are watching", ({ Given, And, When, Then }) => {
        Given("the reader's server is deployed with PUBLIC_REALTIME {string}", deployed);
        And("{string} streams the playground share of the first lab of {string} from the reader", streamsPlayground);
        When("{string} asks the reader to publish {string} for {string} on the playground share of the first lab", publishesOnPlayground);
        Then("the reader answers {number}", answers);
        And("the playground stream receives nothing", receivesNothing("playground"));
      });
    }
  );

  Rule(
    "When a browser that is not signed in as an educator of the course streams a playground share, the reader shall send it only the lecturers' watching announcements.",
    ({ RuleScenario }) => {
      RuleScenario("A sharing student hears the lecturer watching but sees no one's work", ({ Given, And, When, Then }) => {
        Given("the reader's server is deployed with PUBLIC_REALTIME {string}", deployed);
        And("{string} streams the playground share of the first lab of {string} from the reader", (_ctx, name: string) => {
          as(name);
          return streamFromReader("playground", playground());
        });
        When("{string} asks the reader to publish {string} for {string} on the playground share of the first lab", async (_ctx, name: string, event: string, studentId: string) => {
          await publishes(name, event, playground(), studentId);
          expect(response.status).toBe(202);
        });
        And("{string} asks the reader to publish {string} for {string} on the playground share of the first lab", async (_ctx, name: string, event: string, studentId: string) => {
          await publishes(name, event, playground(), studentId);
          expect(response.status).toBe(202);
        });
        Then("the playground stream receives only the watching announcement", async () => {
          await vi.waitFor(() => expect(streams.playground.frames).toEqual([{ event: "watching", payload: { studentId: "eve", files: [] }, from: "tab-1" }]));
          await new Promise((resolve) => setTimeout(resolve, 20));
          expect(streams.playground.frames.map((f) => f.event)).toEqual(["watching"]);
        });
      });

      RuleScenario("A signed-out browser cannot stream a playground share", ({ Given, When, Then, And }) => {
        Given("the reader's server is deployed with PUBLIC_REALTIME {string}", deployed);
        When("a signed-out browser asks the reader for the stream of the playground share of the first lab", async () => {
          as(null);
          response = await readerRequest("GET", `/api/realtime/stream?topic=${encodeURIComponent(playground())}`);
        });
        Then("the reader answers {number}", answers);
        And("nothing listens to the playground share", () => expect(hub().subscribed()).toEqual([]));
      });
    }
  );

  Rule(
    "If a browser's realtime stream fails, then tutors shall close the stream and reopen it after the realtime gateway's full-jitter backoff instead of the browser's own fixed retry.",
    ({ RuleScenario }) => {
      RuleScenario("A failed stream is reopened after the gateway's backoff", ({ Given, And, When, Then }) => {
        let gateway: ReturnType<typeof createRealtimeGateway>;
        Given("a reader tab whose realtime gateway streams over server-sent events with a random draw of {number}", (_ctx, draw: number) => {
          vi.useFakeTimers();
          const adapter = sseRealtimeAdapter({ clientId: "tab-1", eventSource: (url) => sources[sources.push(new FakeEventSource(url)) - 1] });
          gateway = createRealtimeGateway({ adapter, random: () => draw });
        });
        And("the tab streams the broadcasts of {string}", async (_ctx, courseId: string) => {
          tabSubscription = gateway.subscribe(topics.courseBroadcasts(courseId), { onMessage: () => {} });
          await vi.advanceTimersByTimeAsync(0);
          expect(sources.map((s) => s.url)).toEqual([`/api/realtime/stream?topic=${encodeURIComponent(topics.courseBroadcasts(courseId))}`]);
          sources[0].onopen?.({});
          expect(tabSubscription.state()).toBe("live");
        });
        When("the stream fails", () => sources[0].onerror?.({}));
        Then("the failed stream is closed", () => {
          expect(sources[0].closed).toBe(true);
          expect(tabSubscription!.state()).toBe("degraded");
        });
        And("no stream is reopened before {number} ms", async (_ctx, ms: number) => {
          await vi.advanceTimersByTimeAsync(ms - 1);
          expect(sources).toHaveLength(1);
        });
        And("one stream is reopened at {number} ms", async () => {
          await vi.advanceTimersByTimeAsync(1);
          expect(sources).toHaveLength(2);
          expect(sources[1].closed).toBe(false);
        });
      });
    }
  );
});
