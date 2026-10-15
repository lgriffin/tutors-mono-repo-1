import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import type { LiveEvent } from "@tutors/domain/live";
import type { LiveBus, LiveEventReporter, LivePresenceStore, LiveWarehouse } from "@tutors/application/ports";
import { acceptLiveEvents, createIngestor, statsFor, type AcceptedBatch, type Ingestor, type StatsResponse } from "@tutors/application";
import { inMemoryLiveBus, inMemoryPresenceStore, inMemoryWarehouse } from "@tutors/application/testing";
import { httpLiveEventReporter } from "@tutors/live-events-http";
import { configureAdapters } from "@tutors/svelte-state/adapters";
import { optInToLiveEvents, reportCourseOpened, reportLoViewed } from "../../../../packages/adapters/driving/svelte-state/src/connect/services/live-events.ts";

const feature = await loadFeature("tests/bdd/features/live/live-activity.feature");

const list = (csv: string) => csv.split(",").map((item) => item.trim());
const now = new Date("2026-09-17T12:00:00.000Z");

describeFeature(feature, ({ Rule }) => {
  Rule("When a reader posts a batch of live events, the live dashboard shall publish every event that passes validation and report each rejected event with its reason.", ({ RuleScenario }) => {
    let bus: LiveBus;
    let carried: LiveEvent[];
    let outcome: AcceptedBatch;

    const onBus = (ctx: { Given: (text: string, fn: () => Promise<void>) => void }) =>
      ctx.Given("the live dashboard runs on the in-memory bus", async () => {
        bus = inMemoryLiveBus();
        carried = [];
        await bus.subscribe((event) => {
          carried.push(event);
        });
      });
    const posts = (ctx: { When: (text: string, fn: (c: unknown, valid: number, bad: number, type: string) => Promise<void>) => void }) =>
      ctx.When("a reader posts a batch of {number} valid events and {number} event of type {string}", async (_ctx, valid: number, bad: number, type: string) => {
        const ts = "2026-09-17T10:00:00.000Z";
        const good = Array.from({ length: valid }, (_, i) => ({ type: i === 0 ? "session.started" : "course.opened", ts, sid: "s1", course: "cs101" }));
        const junk = Array.from({ length: bad }, () => ({ type, ts, sid: "s1", course: "cs101" }));
        outcome = await acceptLiveEvents({ bus })([...good, ...junk]);
      });
    const carries = (ctx: { Then: (text: string, fn: (c: unknown, n: number) => void) => void }) =>
      ctx.Then("the bus carries {number} events", (_ctx, count: number) => {
        expect(carried).toHaveLength(count);
      });
    const reported = (ctx: { And: (text: string, fn: (c: unknown, a: number, r: number, reason: string) => void) => void }) =>
      ctx.And("the batch is reported as {number} accepted and {number} rejected for {string}", (_ctx, accepted: number, rejected: number, reason: string) => {
        expect(outcome.events).toHaveLength(accepted);
        expect(outcome.rejected.map((entry) => entry.reason)).toEqual(Array.from({ length: rejected }, () => reason));
      });

    RuleScenario("A batch with one malformed event loses only that event", (ctx) => {
      onBus(ctx);
      posts(ctx);
      carries(ctx);
      reported(ctx);
    });
    RuleScenario("A batch with nothing to believe is refused", (ctx) => {
      onBus(ctx);
      posts(ctx);
      carries(ctx);
      reported(ctx);
    });
  });

  // The ingest use case on the in-memory presence store and warehouse, shared by the two Rules that drive it.
  let hot: LivePresenceStore;
  let warehouse: LiveWarehouse;
  let ingestor: Ingestor;
  let course: string;

  const ingests = (ctx: { Given: (text: string, fn: (c: unknown, id: string) => void) => void }) =>
    ctx.Given("the live dashboard ingests events for the course {string}", (_ctx, courseId: string) => {
      course = courseId;
      hot = inMemoryPresenceStore();
      warehouse = inMemoryWarehouse({ now: () => now });
      ingestor = createIngestor({ hot, warehouse });
    });
  const sessionTalks = (ctx: { When: (text: string, fn: (c: unknown, sid: string, opened: string, beat: string) => Promise<void>) => void }) =>
    ctx.When("the session {string} opens the course at {string} and sends a heartbeat at {string}", async (_ctx, sid: string, opened: string, beat: string) => {
      await ingestor.handleBatch([
        { type: "session.started", ts: opened, sid, course },
        { type: "course.opened", ts: opened, sid, course },
        { type: "session.heartbeat", ts: beat, sid, course }
      ]);
    });
  const sweeps = (ctx: { And: (text: string, fn: (c: unknown, at: string) => Promise<void>) => void }) =>
    ctx.And("the sweeper runs at {string}", async (_ctx, at: string) => {
      await ingestor.sweep(new Date(at));
    });

  Rule("If a live session sends no event for 30 minutes, then the live dashboard shall close the session with the duration up to its last event.", ({ RuleScenario }) => {
    const wide = () => ({ from: new Date("2026-09-01T00:00:00.000Z"), to: now, course });
    RuleScenario("The sweeper closes a session a closed laptop never ended", (ctx) => {
      ingests(ctx);
      sessionTalks(ctx);
      sweeps(ctx);
      ctx.Then("the warehouse holds {number} completed session for {string} lasting {number} seconds", async (_ctx, count: number, courseId: string, seconds: number) => {
        const sessions = await warehouse.sessions({ ...wide(), course: courseId });
        expect(sessions).toHaveLength(count);
        expect(sessions[0]?.durationSec).toBe(seconds);
      });
    });
    RuleScenario("A session that is still talking stays open", (ctx) => {
      ingests(ctx);
      sessionTalks(ctx);
      sweeps(ctx);
      ctx.Then("the warehouse holds {number} completed sessions for {string}", async (_ctx, count: number, courseId: string) => {
        expect(await warehouse.sessions({ ...wide(), course: courseId })).toHaveLength(count);
        expect(ingestor.openSessions()).toBe(1);
      });
    });
  });

  Rule("The live dashboard shall count a session as active only while its last event is within the 2-minute presence window.", ({ RuleScenario }) => {
    RuleScenario("A session goes quiet and leaves the Now panel", (ctx) => {
      ingests(ctx);
      sessionTalks(ctx);
      const activeAt = async (at: string, count: number, courseId: string) => {
        const snapshot = await hot.now(new Date(at));
        expect(snapshot.activeSessions).toBe(count);
        expect(snapshot.courses.find((entry) => entry.course === courseId)?.active ?? 0).toBe(count);
      };
      ctx.Then("the Now panel at {string} shows {number} active session on {string}", (_ctx, at: string, count: number, courseId: string) => activeAt(at, count, courseId));
      ctx.And("the Now panel at {string} shows {number} active sessions on {string}", (_ctx, at: string, count: number, courseId: string) => activeAt(at, count, courseId));
    });
  });

  Rule("While a learner has not opted in, the reader shall report live events that carry the rotating session token and no identifier.", ({ RuleScenario }) => {
    let reporter: LiveEventReporter;
    const pointed = (ctx: { Given: (text: string, fn: () => void) => void }) =>
      ctx.Given("a reader pointed at the live dashboard's ingest endpoint", () => {
        // The composition root's job: the HTTP reporter with an endpoint and a fetch that never leaves the test.
        reporter = httpLiveEventReporter({ endpoint: "https://live.example/api/live/events", storage: null, fetch: async () => new Response(null, { status: 202 }) });
        configureAdapters({ liveEvents: reporter });
      });
    const opens = (ctx: { When: (text: string, fn: (c: unknown, courseId: string, lab: string) => void) => void }) =>
      ctx.When("the reader opens the course {string} and the lab {string}", (_ctx, courseId: string, lab: string) => {
        reportCourseOpened(courseId);
        reportLoViewed(courseId, lab, "lab");
      });

    RuleScenario("An anonymous reader is counted without an identity", (ctx) => {
      pointed(ctx);
      opens(ctx);
      ctx.Then("the reader queues the events {string} for {string}", (_ctx, types: string, courseId: string) => {
        expect(reporter.pending().map((event) => event.type)).toEqual(list(types));
        expect(reporter.pending().every((event) => event.course === courseId && event.sid === reporter.sid)).toBe(true);
      });
      ctx.And("none of the queued events carries an identifier", () => {
        expect(reporter.pending().some((event) => "uid" in event)).toBe(false);
      });
    });
    RuleScenario("A learner who opted in is counted under a hash, never a login", (ctx) => {
      pointed(ctx);
      ctx.And("the signed-in learner {string} has opted in", async (_ctx, login: string) => {
        await optInToLiveEvents(login);
      });
      opens(ctx);
      ctx.Then("the session start carries a {number}-character identifier that is not {string}", (_ctx, length: number, login: string) => {
        const started = reporter.pending().find((event) => event.type === "session.started") as { uid?: string } | undefined;
        expect(started?.uid).toHaveLength(length);
        expect(started?.uid).not.toContain(login);
      });
    });
  });

  Rule("The live dashboard shall report, for the selected range, the completed sessions, the views and the median session length of that range only.", ({ RuleScenario }) => {
    let store: LiveWarehouse;
    let stats: StatsResponse;
    const seedSession = async (courseId: string, seconds: number, views: number, daysAgo: number, sid: string) => {
      const start = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000);
      const ts = start.toISOString();
      const events: LiveEvent[] = [
        { type: "session.started", ts, sid, course: courseId },
        ...Array.from({ length: views }, (_, i): LiveEvent => ({ type: "lo.viewed", ts, sid, course: courseId, lo: `/lab-${i}`, loType: "lab" }))
      ];
      await store.append(events);
      const end = new Date(start.getTime() + seconds * 1000).toISOString();
      await store.upsertSession({ sid, course: courseId, uid: null, startedAt: ts, endedAt: end, durationSec: seconds });
    };
    const holds = (ctx: { Given: (text: string, fn: (c: unknown, ...args: (number | string)[]) => Promise<void>) => void }) =>
      ctx.Given(
        "the warehouse holds a {number}-second session on {string} with {number} views {number} day ago and a {number}-second session on {string} with {number} view {number} days ago",
        async (_ctx, s1, c1, v1, d1, s2, c2, v2, d2) => {
          store = inMemoryWarehouse({ now: () => now });
          await seedSession(String(c1), Number(s1), Number(v1), Number(d1), "recent");
          await seedSession(String(c2), Number(s2), Number(v2), Number(d2), "old");
        }
      );
    const reads = (ctx: { When: (text: string, fn: (c: unknown, range: string) => Promise<void>) => void }) =>
      ctx.When("the stats for the range {string} are read", async (_ctx, range: string) => {
        stats = await statsFor(store, range as "today" | "7d" | "30d", null, now);
      });
    const shows = (_ctx: unknown, sessions: number, views: number, median: number) => {
      expect([stats.stats.sessions, stats.stats.views, stats.stats.medianSessionSec]).toEqual([sessions, views, median]);
    };

    RuleScenario("Yesterday's session is in the 7-day stats", (ctx) => {
      holds(ctx);
      reads(ctx);
      ctx.Then("the stats show {number} session, {number} views and a median session length of {number} seconds", shows);
    });
    RuleScenario("Yesterday's session is not in today's stats", (ctx) => {
      holds(ctx);
      reads(ctx);
      ctx.Then("the stats show {number} sessions, {number} views and a median session length of {number} seconds", shows);
    });
  });
});
