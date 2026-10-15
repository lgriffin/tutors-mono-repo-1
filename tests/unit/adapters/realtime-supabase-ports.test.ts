/**
 * The Supabase Realtime adapters (PlaygroundLive, CourseNotices, PresencePort) over a fake broker
 * that behaves like Supabase Realtime: a joined channel hears the broadcasts of every other client
 * on its topic, `httpSend` reaches them without joining, and the subscribe callback reports
 * SUBSCRIBED. Each tab gets its own client and gateway, as in the browser, so a student and a
 * lecturer are two tabs on one broker. The ports' contract suites run against them.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { courseNoticesContract, playgroundLiveContract, type ContractCase } from "@tutors/application/testing";
import type { CourseNotice, PlaygroundLive, PlaygroundLiveState } from "@tutors/application/ports";
import type { PresenceEvent } from "@tutors/domain/presence";
import { createRealtimeGateway, topics } from "@tutors/realtime";
import {
  COURSE_NOTICES_ROUTE,
  isCourseNotice,
  LIVE_STORED_WINDOW_MS,
  LIVE_WATCH_MS,
  noticeEvent,
  noticeTopic,
  playgroundTopic,
  publishCourseNotice,
  realtimeClientOptions,
  supabaseCourseNotices,
  supabasePlaygroundLive,
  supabasePresence,
  supabaseRealtimeAdapter
} from "@tutors/realtime-supabase";
import log from "@tutors/logger";
import { fakePostgrest } from "../../support/fake-postgrest.ts";

vi.mock("@tutors/logger", () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

type Message = { event: string; payload?: unknown };
type Member = { hear: (message: Message) => void; self: boolean };

/** One Realtime project: the topics and who has joined each. */
function fakeBroker() {
  const members = new Map<string, Set<Member>>();
  const on = (topic: string) => {
    const set = members.get(topic) ?? new Set<Member>();
    members.set(topic, set);
    return set;
  };
  const published: { topic: string; event: string; payload: unknown }[] = [];

  /** One tab's Supabase client on this broker. */
  function client(options: { tier?: string | null; rpcError?: boolean; db?: ReturnType<typeof fakePostgrest> } = {}) {
    const channels = new Map<object, { topic: string; member: Member }>();
    const deliver = (topic: string, from: Member | null, message: Message) => {
      for (const member of [...on(topic)]) if (member !== from || member.self) member.hear(message);
    };
    return {
      channel(topic: string, config?: { config?: { broadcast?: { self?: boolean } } }) {
        const member: Member = { hear: () => {}, self: config?.config?.broadcast?.self ?? false };
        const channel = {
          on(_type: string, _filter: { event: string }, handler: (message: Message) => void) {
            member.hear = handler;
            return channel;
          },
          subscribe(callback: (status: string) => void) {
            on(topic).add(member);
            channels.set(channel, { topic, member });
            callback("SUBSCRIBED");
            return channel;
          },
          async send(message: { type: string; event: string; payload: unknown }) {
            deliver(topic, member, { event: message.event, payload: message.payload });
            return "ok";
          },
          async httpSend(event: string, payload: unknown) {
            published.push({ topic, event, payload });
            deliver(topic, null, { event, payload });
            return { success: true };
          }
        };
        return channel;
      },
      async removeChannel(channel: object) {
        const joined = channels.get(channel);
        if (joined) on(joined.topic).delete(joined.member);
        channels.delete(channel);
        return "ok";
      },
      rpc: vi.fn<(name: string, args: unknown) => Promise<unknown>>(async () => (options.rpcError ? { data: null, error: { message: "no such function" } } : { data: { tier: options.tier === undefined ? "normal" : options.tier }, error: null })),
      from: (table: string) => (options.db ?? fakePostgrest()).client.from(table)
    };
  }

  return { client, published, joined: (topic: string) => on(topic).size };
}

const tab = (broker: ReturnType<typeof fakeBroker>, options?: Parameters<ReturnType<typeof fakeBroker>["client"]>[0]) => broker.client(options) as never;
const gatewayFor = (client: never) => createRealtimeGateway({ adapter: supabaseRealtimeAdapter(client) });

function contract(name: string, cases: ContractCase[], elsewhere: Record<string, string> = {}) {
  describe(name, () => {
    for (const c of cases) if (!(c.name in elsewhere)) it(c.name, c.run);
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A student's tab sharing and a lecturer's tab watching, on one broker. */
function playgroundTabs(): PlaygroundLive {
  const broker = fakeBroker();
  const student = supabasePlaygroundLive(gatewayFor(tab(broker)));
  const lecturer = supabasePlaygroundLive(gatewayFor(tab(broker)));
  return { share: student.share.bind(student), watch: lecturer.watch.bind(lecturer) };
}

contract("PlaygroundLive: Supabase Realtime", playgroundLiveContract(playgroundTabs), {
  // The watcher polls its link every 250 ms before announcing itself, longer than the contract's
  // one-tick settle; the announcement is covered below with a controlled clock.
  "a lecturer's arrival is announced to the students sharing": "announcement polls on a 250 ms interval"
});

describe("supabasePlaygroundLive", () => {
  const state = (studentId: string): PlaygroundLiveState => ({ studentId, studentName: studentId, files: [], activePath: "main.py", output: "", running: false, updatedAt: "2026-09-10T09:00:00.000Z" });

  it("announces a lecturer to the sharing students once the link is live, and only once", async () => {
    vi.useFakeTimers();
    const broker = fakeBroker();
    const student = supabasePlaygroundLive(gatewayFor(tab(broker)));
    const lecturer = supabasePlaygroundLive(gatewayFor(tab(broker)));
    const onWatcher = vi.fn();
    const share = student.share("cs101", "/playground/cs101/hello", onWatcher);
    const stop = lecturer.watch("cs101", "/playground/cs101/hello", () => {});

    await vi.advanceTimersByTimeAsync(1000);

    expect(onWatcher).toHaveBeenCalledOnce();
    stop();
    stop();
    share.stop();
    share.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(broker.joined(playgroundTopic("cs101", "/playground/cs101/hello"))).toBe(0);
  });

  it("stops polling a link that was refused, without announcing", async () => {
    vi.useFakeTimers();
    const broker = fakeBroker();
    const gateway = createRealtimeGateway({ adapter: supabaseRealtimeAdapter(tab(broker)), budget: { eventsPerSecond: 10, maxChannels: 0, backoffBaseMs: 1, backoffMaxMs: 1 } });
    const subscribe = vi.spyOn(gateway, "subscribe");
    supabasePlaygroundLive(gateway).watch("cs101", "lo", () => {});

    await vi.advanceTimersByTimeAsync(1000);

    expect(subscribe.mock.results[0].value.state()).toBe("closed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores a state with no student, and logs a send that could not go out", async () => {
    const broker = fakeBroker();
    const lecturer = supabasePlaygroundLive(gatewayFor(tab(broker)));
    const seen: string[] = [];
    lecturer.watch("cs101", "lo", (s) => seen.push(s.studentId));
    const studentClient = tab(broker);
    const raw = (studentClient as unknown as ReturnType<ReturnType<typeof fakeBroker>["client"]>).channel(playgroundTopic("cs101", "lo"));
    raw.on("broadcast", { event: "*" }, () => {}).subscribe(() => {});
    await raw.send({ type: "broadcast", event: "state", payload: { studentName: "nobody" } });
    await raw.send({ type: "broadcast", event: "state", payload: state("ada") });
    expect(seen).toEqual(["ada"]);

    const refusing = createRealtimeGateway({ adapter: supabaseRealtimeAdapter(tab(broker)), budget: { eventsPerSecond: 0, maxChannels: 3, backoffBaseMs: 1, backoffMaxMs: 1 } });
    supabasePlaygroundLive(refusing).share("cs101", "lo", () => {}).send(state("ada"));
    expect(log.debug).toHaveBeenCalledWith("playground live state not sent (link not live or budget spent)");
  });
});

/** A dashboard tab watching, and the app's server publishing over REST, on one broker. */
function noticesTabs() {
  const broker = fakeBroker();
  const server = tab(broker);
  return supabaseCourseNotices(tab(broker), { post: (notice) => publishCourseNotice(server, notice) });
}

contract("CourseNotices: Supabase Realtime", courseNoticesContract(noticesTabs));

describe("course notices", () => {
  const broadcast = (overrides: Record<string, unknown> = {}) => ({ type: "course:broadcast", id: "b1", courseId: "cs101", sentAt: 1, title: "Lab moved", description: "Room 2", senderName: "Lecturer", ...overrides });

  it("puts each kind of notice on its own course topic and event", () => {
    expect(noticeTopic("cs101", "gist-created")).toBe(topics.courseSnippets("cs101"));
    expect(noticeTopic("cs101", "course:broadcast")).toBe(topics.courseBroadcasts("cs101"));
    expect(noticeEvent("course:broadcast")).toBe("course-broadcast");
  });

  it("accepts a broadcast only with a title, a description and a sender", () => {
    expect(isCourseNotice(broadcast(), "cs101", "course:broadcast")).toBe(true);
    expect(isCourseNotice(broadcast({ title: "" }), "cs101", "course:broadcast")).toBe(false);
    expect(isCourseNotice(broadcast({ description: 3 }), "cs101", "course:broadcast")).toBe(false);
    expect(isCourseNotice(broadcast({ senderName: undefined }), "cs101", "course:broadcast")).toBe(false);
    expect(isCourseNotice(broadcast(), "cs102", "course:broadcast")).toBe(false);
    expect(isCourseNotice(broadcast({ sentAt: "1" }), "cs101", "course:broadcast")).toBe(false);
    expect(isCourseNotice(null, "cs101", "course:broadcast")).toBe(false);
  });

  it("delivers a lecturer's broadcast to a reader on the course", async () => {
    const notices = noticesTabs();
    const heard: CourseNotice[] = [];
    notices.watch("cs101", "course:broadcast", (notice) => heard.push(notice));
    expect(await notices.post(broadcast() as CourseNotice)).toBe(true);
    expect(heard).toEqual([broadcast()]);
  });

  it("refuses to publish without a client or a course, and reports a publish that fails", async () => {
    expect(await publishCourseNotice(undefined, broadcast() as CourseNotice)).toBe(false);
    const failing = { channel: () => ({ httpSend: async () => Promise.reject(new Error("503")) }) };
    expect(await publishCourseNotice(failing as never, broadcast({ courseId: "" }) as CourseNotice)).toBe(false);
    expect(await publishCourseNotice(failing as never, broadcast() as CourseNotice)).toBe(false);
    expect(log.error).toHaveBeenCalledWith("Publishing a course notice failed:", "course:broadcast", "cs101", expect.any(Error));
  });

  it("by default posts the notice to the app's server and reports whether it was accepted", async () => {
    const fetchStub = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchStub);
    const notices = supabaseCourseNotices(tab(fakeBroker()));

    expect(await notices.post(broadcast() as CourseNotice)).toBe(true);
    expect(fetchStub).toHaveBeenCalledWith(COURSE_NOTICES_ROUTE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(broadcast()) });

    fetchStub.mockRejectedValueOnce(new TypeError("offline"));
    expect(await notices.post(broadcast() as CourseNotice)).toBe(false);
    expect(log.warn).toHaveBeenCalledWith("Posting a course notice failed:", expect.any(TypeError));

    vi.stubGlobal("fetch", undefined);
    expect(await notices.post(broadcast() as CourseNotice)).toBe(false);
  });

  it("leaves the topic once, however often the watcher unsubscribes", async () => {
    const broker = fakeBroker();
    const notices = supabaseCourseNotices(tab(broker));
    const stop = notices.watch("cs101", "gist-created", () => {});
    expect(broker.joined(noticeTopic("cs101", "gist-created"))).toBe(1);
    stop();
    stop();
    await Promise.resolve();
    expect(broker.joined(noticeTopic("cs101", "gist-created"))).toBe(0);
  });

  it("logs a failed broadcast or leave on its default gateway rather than throwing", async () => {
    const broken = {
      channel: () => {
        const channel = {
          on: () => channel,
          subscribe: (callback: (status: string) => void) => (callback("SUBSCRIBED"), channel),
          send: () => Promise.reject(new Error("socket closed"))
        };
        return channel;
      },
      removeChannel: () => Promise.reject(new Error("already gone"))
    };
    const notices = supabaseCourseNotices(broken as never);
    const stop = notices.watch("cs101", "gist-created", () => {});
    notices.gateway.subscribe(noticeTopic("cs101", "gist-created"), { onMessage: () => {} }).send("gist-created", {});
    stop();
    await notices.gateway.reset();

    expect(log.error).toHaveBeenCalledWith("Realtime broadcast failed:", "snippets:cs101", expect.any(Error));
    expect(log.error).toHaveBeenCalledWith("Leaving a Realtime channel failed:", "snippets:cs101", expect.any(Error));
  });
});

describe("supabasePresence", () => {
  const event = (id: string, loRoute = "/lab/cs101/1"): PresenceEvent => ({
    courseId: "cs101",
    courseUrl: "cs101.netlify.app",
    courseTitle: "CS 101",
    loRoute,
    title: "Lab",
    isPrivate: false,
    type: "lab",
    user: { id, fullName: id, avatar: "", sentiment: "neutral" }
  });
  const now = new Date("2026-09-17T10:00:00.000Z");
  const stored = (id: string, minutesAgo: number, courseId = "cs101") => ({ course_id: courseId, student_id: id, payload: event(id, `/lab/${id}`), received_at: new Date(now.getTime() - minutesAgo * 60_000).toISOString() });

  it("hands a subscriber what the reader's server publishes on the course topic", async () => {
    const broker = fakeBroker();
    const presence = supabasePresence(tab(broker), () => now, { report: () => {} });
    const heard: string[] = [];
    const stop = presence.subscribe((e) => heard.push(e.user!.id), "cs101");

    const server = tab(broker);
    await supabaseRealtimeAdapter(server).publish(topics.courseActivity("cs101"), "lo-event", event("ann"));
    await supabaseRealtimeAdapter(server).publish(topics.courseActivity("cs101"), "lo-event", undefined);
    await supabaseRealtimeAdapter(server).publish(topics.courseActivity("cs101"), "other", event("bob"));
    stop();
    stop();

    expect(heard).toEqual(["ann"]);
  });

  /** The data API's stored roster over `rows`: newest first, one course's or every course's, since a time. */
  const rosterOver = (rows: ReturnType<typeof stored>[]) =>
    vi.fn(async (courseId: string | undefined, sinceIso: string) =>
      rows
        .filter((row) => (!courseId || row.course_id === courseId) && row.received_at >= sinceIso)
        .sort((x, y) => y.received_at.localeCompare(x.received_at))
    );

  it("reads the stored activity, oldest first, while the day's budget is paused, and reports itself as a watcher every minute", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const watch = vi.fn(async () => "paused" as const);
    const roster = rosterOver([stored("ann", 1), stored("bob", 0.5), stored("old", 10), stored("cat", 1, "cs102")]);
    const presence = supabasePresence(tab(fakeBroker()), () => now, { report: () => {}, roster, watch });
    const heard: string[] = [];

    const stop = presence.subscribe((e) => heard.push(e.user!.id), "cs101");
    await vi.waitFor(() => expect(heard).toEqual(["ann", "bob"]));
    await vi.advanceTimersByTimeAsync(LIVE_WATCH_MS);
    await vi.waitFor(() => expect(heard).toEqual(["ann", "bob", "ann", "bob"]));
    stop();
    await vi.advanceTimersByTimeAsync(LIVE_WATCH_MS * 3);

    expect(watch).toHaveBeenCalledWith(topics.courseActivity("cs101"), expect.any(String));
    expect(watch).toHaveBeenCalledTimes(2);
    expect(roster).toHaveBeenCalledWith("cs101", new Date(now.getTime() - LIVE_STORED_WINDOW_MS).toISOString());
    expect(LIVE_STORED_WINDOW_MS).toBe(2 * LIVE_WATCH_MS);
    vi.useRealTimers();
  });

  it("falls back to the stored activity across every course when the watcher report fails, or when nothing reports", async () => {
    const roster = rosterOver([stored("ann", 1), stored("cat", 1, "cs102")]);
    for (const watch of [vi.fn(async () => null), undefined]) {
      const presence = supabasePresence(tab(fakeBroker()), () => now, { report: () => {}, roster, watch });
      const heard: string[] = [];
      const stop = presence.subscribe((e) => heard.push(e.user!.id));
      await vi.waitFor(() => expect(heard.sort()).toEqual(["ann", "cat"]));
      stop();
    }
    expect(roster).toHaveBeenCalledWith(undefined, expect.any(String));
  });

  it("does not read the stored activity while the server is publishing, nor after unsubscribing", async () => {
    const roster = rosterOver([stored("ann", 1)]);
    const heard: string[] = [];
    supabasePresence(tab(fakeBroker()), () => now, { report: () => {}, roster, watch: async () => "slow" }).subscribe((e) => heard.push(e.user!.id), "cs101");
    const late = supabasePresence(tab(fakeBroker()), () => now, { report: () => {}, roster, watch: async () => "paused" });
    late.subscribe((e) => heard.push(e.user!.id), "cs101")();
    await new Promise((done) => setTimeout(done, 5));

    expect(heard).toEqual([]);
    expect(roster).not.toHaveBeenCalled();
  });

  it("answers null when the stored roster cannot be read, or when none is composed", async () => {
    const roster = vi.fn(async () => null);
    expect(await supabasePresence(tab(fakeBroker()), () => now, { report: () => {}, roster }).recent("cs101", now.toISOString())).toBeNull();
    expect(roster).toHaveBeenCalledWith("cs101", now.toISOString());
    expect(await supabasePresence(tab(fakeBroker()), () => now, { report: () => {} }).recent("cs101", now.toISOString())).toBeNull();

    const heard: string[] = [];
    const stop = supabasePresence(tab(fakeBroker()), () => now, { report: () => {}, roster, watch: async () => "paused" }).subscribe((e) => heard.push(e.user!.id), "cs102");
    await vi.waitFor(() => expect(roster).toHaveBeenCalledWith("cs102", expect.any(String)));
    stop();
    expect(heard).toEqual([]);
  });

  it("lists nobody for a blank course, without reading the roster", async () => {
    const roster = rosterOver([stored("ann", 1)]);
    const presence = supabasePresence(tab(fakeBroker()), () => now, { report: () => {}, roster });
    expect(await presence.recent("  ", now.toISOString())).toEqual([]);
    expect(roster).not.toHaveBeenCalled();
  });

  it("stores the learner's snapshot through the composed store, and only for a named course and learner", async () => {
    const store = vi.fn(async () => {});
    const report = vi.fn();
    const presence = supabasePresence(tab(fakeBroker()), () => now, { report, store });

    await presence.publish(event("ann"));
    await presence.publish({ ...event("ann"), courseId: " " });
    await presence.publish({ ...event(""), user: undefined } as PresenceEvent);

    expect(report).toHaveBeenCalledTimes(3);
    expect(store).toHaveBeenCalledOnce();

    store.mockRejectedValueOnce(new Error("401"));
    await presence.publish(event("ann"));
    expect(log.error).toHaveBeenCalledWith("upsertTutorsConnectLatestLo failed:", expect.any(Error));

    // No store composed: nothing is written, and nothing fails.
    await supabasePresence(tab(fakeBroker()), () => now, { report }).publish(event("ann"));
  });

  it("does not report from a runtime without fetch", async () => {
    vi.stubGlobal("fetch", undefined);
    const store = vi.fn(async () => {});
    await expect(supabasePresence(tab(fakeBroker()), () => now, { store }).publish(event("ann"))).resolves.toBeUndefined();
    expect(store).toHaveBeenCalledOnce();
    expect(log.warn).not.toHaveBeenCalledWith("Reporting live activity failed:", expect.anything());
  });

  it("uses the gateway it is given", () => {
    const gateway = gatewayFor(tab(fakeBroker()));
    expect(supabasePresence(tab(fakeBroker()), undefined, { gateway }).gateway).toBe(gateway);
  });
});

describe("realtimeClientOptions", () => {
  it("caps the socket's events per second and reconnects with jittered backoff inside the budget", () => {
    const options = realtimeClientOptions({ eventsPerSecond: 4, maxChannels: 3, backoffBaseMs: 100, backoffMaxMs: 400 });
    expect(options.params).toEqual({ eventsPerSecond: 4 });
    for (const tries of [1, 2, 3, 8]) {
      const wait = options.reconnectAfterMs(tries);
      expect(wait).toBeGreaterThanOrEqual(0);
      expect(wait).toBeLessThanOrEqual(Math.min(400, 100 * 2 ** (tries - 1)));
    }
  });
});
