/**
 * Realtime on Valkey: the hub over a fake pub/sub pair, the server-sent event stream, the topic and
 * message checks the routes use, and the browser's adapter. The ports run their contract suites
 * over a fake EventSource wired to a memory hub, the way a tab's stream reaches the server's hub, so
 * a student and a lecturer are two tabs on one server.
 */
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { courseNoticesContract, playgroundLiveContract, type ContractCase } from "@tutors/application/testing";
import type { CourseNotice, PlaygroundLive } from "@tutors/application/ports";
import type { PresenceEvent } from "@tutors/domain/presence";
import { createRealtimeGateway, topics } from "@tutors/realtime";
import {
  CHANNEL_PREFIX,
  connectValkey,
  MAX_BROWSER_MESSAGE_BYTES,
  memoryRealtimeHub,
  activityTopicOf,
  playgroundOf,
  playgroundTopic,
  playgroundTopicOf,
  publishBrowserMessage,
  publishLiveActivity,
  publishNotice,
  realtimeHub,
  realtimeKindOf,
  realtimeStream,
  sseRealtimeAdapter,
  streamableTopic,
  topicRateLimiter,
  valkeyBrowserRealtime,
  valkeyCourseNotices,
  valkeyPlaygroundLive,
  valkeyPresence,
  valkeyRealtimeHub,
  type EventSourceLike,
  type PubSubClient,
  type RealtimeHub
} from "@tutors/realtime-valkey";
import log from "@tutors/logger";

vi.mock("@tutors/logger", () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function contract(name: string, cases: ContractCase[], elsewhere: Record<string, string> = {}) {
  describe(name, () => {
    for (const c of cases) if (!(c.name in elsewhere)) it(c.name, c.run);
  });
}

/** A fake node-redis connection; `channels` is what this connection has subscribed to. */
function fakeConnection() {
  const channels = new Map<string, (message: string) => void>();
  const client = {
    published: [] as [string, string][],
    channels,
    publish: vi.fn(async (channel: string, message: string) => {
      client.published.push([channel, message]);
      return 1;
    }),
    subscribe: vi.fn(async (channel: string, listener: (message: string) => void) => {
      channels.set(channel, listener);
    }),
    unsubscribe: vi.fn(async (channel: string) => {
      channels.delete(channel);
    }),
    quit: vi.fn(async () => "OK")
  };
  return client satisfies PubSubClient;
}

describe("valkeyRealtimeHub", () => {
  const pair = () => ({ publisher: fakeConnection(), subscriber: fakeConnection() });

  it("subscribes once per topic, however many listeners, and unsubscribes when the last leaves", async () => {
    const conn = pair();
    const connect = vi.fn(async () => conn);
    const hub = valkeyRealtimeHub(connect);
    const a: unknown[] = [];
    const b: unknown[] = [];
    const leaveA = await hub.subscribe("cs101", (m) => a.push(m));
    const leaveB = await hub.subscribe("cs101", (m) => b.push(m));

    expect(connect).toHaveBeenCalledOnce();
    expect(conn.subscriber.subscribe).toHaveBeenCalledOnce();
    expect(hub.subscribed()).toEqual(["cs101"]);

    conn.subscriber.channels.get(`${CHANNEL_PREFIX}cs101`)!(JSON.stringify({ event: "lo-event", payload: { n: 1 } }));
    conn.subscriber.channels.get(`${CHANNEL_PREFIX}cs101`)!("not json");
    conn.subscriber.channels.get(`${CHANNEL_PREFIX}cs101`)!(JSON.stringify({ payload: "no event" }));
    conn.subscriber.channels.get(`${CHANNEL_PREFIX}cs101`)!(JSON.stringify({ event: "state", payload: 1, from: "tab-1" }));
    expect(a).toEqual([
      { event: "lo-event", payload: { n: 1 } },
      { event: "state", payload: 1, from: "tab-1" }
    ]);
    expect(b).toEqual(a);

    await leaveA();
    await leaveA();
    expect(conn.subscriber.unsubscribe).not.toHaveBeenCalled();
    await leaveB();
    expect(conn.subscriber.unsubscribe).toHaveBeenCalledWith(`${CHANNEL_PREFIX}cs101`);
    expect(hub.subscribed()).toEqual([]);
  });

  it("publishes JSON on the prefixed channel and quits both connections on close", async () => {
    const conn = pair();
    const hub = valkeyRealtimeHub(async () => conn);
    await hub.publish("broadcast:cs101", { event: "course-broadcast", payload: { id: "b1" } });
    expect(conn.publisher.published).toEqual([[`${CHANNEL_PREFIX}broadcast:cs101`, JSON.stringify({ event: "course-broadcast", payload: { id: "b1" } })]]);

    await hub.close();
    expect(conn.publisher.quit).toHaveBeenCalledOnce();
    expect(conn.subscriber.quit).toHaveBeenCalledOnce();
    await valkeyRealtimeHub(async () => conn).close();
  });

  it("reconnects on the next use after a failed connection, and a failed subscribe leaves no topic behind", async () => {
    const conn = pair();
    const connect = vi.fn<() => Promise<typeof conn>>().mockRejectedValueOnce(new Error("ECONNREFUSED")).mockResolvedValue(conn);
    const hub = valkeyRealtimeHub(connect);
    await expect(hub.subscribe("cs101", () => {})).rejects.toThrow("ECONNREFUSED");
    expect(hub.subscribed()).toEqual([]);

    await hub.subscribe("cs101", () => {});
    expect(connect).toHaveBeenCalledTimes(2);
    expect(hub.subscribed()).toEqual(["cs101"]);
  });

  it("subscribes again only after an UNSUBSCRIBE still in flight, so a stream that reopens at once stays subscribed", async () => {
    const conn = pair();
    let finishLeaving: () => void = () => {};
    conn.subscriber.unsubscribe.mockImplementationOnce(
      (channel: string) =>
        new Promise<void>((resolve) => {
          finishLeaving = () => {
            conn.subscriber.channels.delete(channel);
            resolve();
          };
        })
    );
    const hub = valkeyRealtimeHub(async () => conn);
    const leave = await hub.subscribe("cs101", () => {});
    const leaving = leave();
    await vi.waitFor(() => expect(conn.subscriber.unsubscribe).toHaveBeenCalledOnce());

    const heard: unknown[] = [];
    const rejoined = hub.subscribe("cs101", (m) => heard.push(m));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(conn.subscriber.subscribe).toHaveBeenCalledOnce();
    finishLeaving();
    await leaving;
    await rejoined;
    expect(conn.subscriber.subscribe).toHaveBeenCalledTimes(2);
    conn.subscriber.channels.get(`${CHANNEL_PREFIX}cs101`)!(JSON.stringify({ event: "lo-event", payload: {} }));
    expect(heard).toEqual([{ event: "lo-event", payload: {} }]);
  });

  it("keeps delivering to the other listeners when one throws", async () => {
    const hub = memoryRealtimeHub();
    const heard: string[] = [];
    await hub.subscribe("cs101", () => {
      throw new Error("boom");
    });
    await hub.subscribe("cs101", (m) => heard.push(m.event));
    await hub.publish("cs101", { event: "lo-event", payload: {} });
    expect(heard).toEqual(["lo-event"]);
    expect(log.error).toHaveBeenCalledWith("A realtime listener failed:", expect.any(Error));
    await hub.close();
    expect(hub.subscribed()).toEqual([]);
  });

  it("keeps one hub per URL for the process, and the memory hub without one", () => {
    expect(realtimeHub(undefined)).toBe(realtimeHub(" "));
    expect(realtimeHub(undefined).kind).toBe("memory");
    const valkey = realtimeHub("redis://valkey.invalid:6379");
    expect(valkey.kind).toBe("valkey");
    expect(realtimeHub("redis://valkey.invalid:6379")).toBe(valkey);
  });

  it("names Valkey only for PUBLIC_REALTIME=valkey", () => {
    expect(realtimeKindOf({ PUBLIC_REALTIME: " Valkey " })).toBe("valkey");
    expect(realtimeKindOf({ PUBLIC_REALTIME: "" })).toBe("supabase");
    expect(realtimeKindOf({})).toBe("supabase");
  });
});

/** Reads a stream's chunks as text until `count` frames (blank-line separated blocks) have arrived. */
async function blocks(response: Response, count: number): Promise<string[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (text.split("\n\n").length - 1 < count) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  reader.releaseLock();
  return text.split("\n\n").slice(0, count);
}

describe("realtimeStream", () => {
  it("answers once subscribed, then sends each message as a data frame, with keep-alives", async () => {
    vi.useFakeTimers();
    const hub = memoryRealtimeHub();
    const response = await realtimeStream(hub, "cs101", { headers: { "access-control-allow-origin": "https://time.test" }, keepAliveMs: 1000 });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(response.headers.get("access-control-allow-origin")).toBe("https://time.test");
    expect(hub.subscribed()).toEqual(["cs101"]);

    await hub.publish("cs101", { event: "lo-event", payload: { n: 1 } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await blocks(response, 3)).toEqual([": subscribed", `data: ${JSON.stringify({ event: "lo-event", payload: { n: 1 } })}`, ": keep-alive"]);
  });

  it("unsubscribes when the browser goes away, by abort or by cancelling", async () => {
    const hub = memoryRealtimeHub();
    const aborted = new AbortController();
    await realtimeStream(hub, "cs101", { signal: aborted.signal });
    const cancelled = await realtimeStream(hub, "cs102");
    expect(hub.subscribed()).toEqual(["cs101", "cs102"]);

    aborted.abort();
    await cancelled.body!.cancel();
    await vi.waitFor(() => expect(hub.subscribed()).toEqual([]));
  });

  it("sends a browser only the messages it may see", async () => {
    const hub = memoryRealtimeHub();
    const response = await realtimeStream(hub, "playground:cs101:/lab/1", { only: (m) => m.event === "watching" });
    await hub.publish("playground:cs101:/lab/1", { event: "state", payload: { studentId: "ann" } });
    await hub.publish("playground:cs101:/lab/1", { event: "watching", payload: {} });
    expect(await blocks(response, 2)).toEqual([": subscribed", `data: ${JSON.stringify({ event: "watching", payload: {} })}`]);
    await response.body!.cancel();
  });

  it("subscribes to nothing for a browser that has already gone", async () => {
    const hub = memoryRealtimeHub();
    const gone = new AbortController();
    gone.abort();
    const response = await realtimeStream(hub, "cs101", { signal: gone.signal });
    expect(hub.subscribed()).toEqual([]);
    expect(await response.text()).toBe("");
  });
});

describe("topics a browser may stream and publish to", () => {
  it("streams only the topics Tutors publishes", () => {
    expect(streamableTopic("tutors-all-course-access")).toBe(topics.platformActivity());
    expect(streamableTopic("web-dev-101")).toBe(topics.courseActivity("web-dev-101"));
    expect(streamableTopic("snippets:web-dev-101")).toBe(topics.courseSnippets("web-dev-101"));
    expect(streamableTopic("broadcast:web-dev-101")).toBe(topics.courseBroadcasts("web-dev-101"));
    expect(streamableTopic("playground:web-dev-101:/lab/web-dev-101/topic-0/lab-0")).toBe(playgroundTopic("web-dev-101", "/lab/web-dev-101/topic-0/lab-0"));
    for (const refused of [
      null,
      42,
      "",
      "../admin",
      "a..b",
      "snippets:",
      "broadcast:../x",
      "playground:web-dev-101",
      "playground::lo",
      "playground:cs101:has space",
      "x".repeat(801),
      `playground:cs101:/${"x".repeat(512)}`,
      "-leading"
    ]) {
      expect(streamableTopic(refused), String(refused)).toBeNull();
    }
  });

  it("accepts a learning object id as long as the reader's data API does", () => {
    const loId = `/${"x".repeat(511)}`;
    expect(playgroundOf(`playground:cs101:${loId}`)).toEqual({ topic: `playground:cs101:${loId}`, courseId: "cs101", loId });
    expect(streamableTopic(`playground:cs101:${loId}`)).toBe(`playground:cs101:${loId}`);
  });

  it("streams only activity from Tutors Live", () => {
    expect(activityTopicOf("tutors-all-course-access")).toBe(topics.platformActivity());
    expect(activityTopicOf("web-dev-101")).toBe("web-dev-101");
    for (const refused of [null, "playground:cs101:/lab/1", "snippets:cs101", "broadcast:cs101", "../admin"]) expect(activityTopicOf(refused), String(refused)).toBeNull();
  });

  it("publishes from a browser only to a playground topic", () => {
    expect(playgroundTopicOf("playground:cs101:/lab/a")).toBe("playground:cs101:/lab/a");
    expect(playgroundTopicOf("broadcast:cs101")).toBeNull();
    expect(playgroundTopicOf(undefined)).toBeNull();
  });
});

describe("what the reader's server publishes", () => {
  const event = { courseId: "cs101", user: { id: "ann", fullName: "Ann" }, title: "Lab 1", loRoute: "/lab/1", isPrivate: false };

  it("publishes a learning event to the course's and the platform's activity topics, with no budget", async () => {
    const hub = memoryRealtimeHub();
    const heard: string[] = [];
    await hub.subscribe("cs101", (m) => heard.push(`course:${m.event}`));
    await hub.subscribe(topics.platformActivity(), (m) => heard.push(`platform:${m.event}`));
    expect(await publishLiveActivity(JSON.stringify(event), hub)).toEqual({ status: 202, body: { tier: "normal", topics: ["cs101", topics.platformActivity()] } });
    expect(heard).toEqual(["course:lo-event", "platform:lo-event"]);
  });

  it("refuses a malformed event, publishes nothing without a hub, and leaves out a topic Valkey failed", async () => {
    expect(await publishLiveActivity("{", memoryRealtimeHub())).toEqual({ status: 400, body: { message: "body is not JSON" } });
    expect(await publishLiveActivity(JSON.stringify(event), null)).toEqual({ status: 204 });
    const failing: RealtimeHub = { ...memoryRealtimeHub(), publish: async (topic) => (topic === "cs101" ? Promise.reject(new Error("down")) : undefined) };
    expect(await publishLiveActivity(JSON.stringify(event), failing)).toEqual({ status: 202, body: { tier: "normal", topics: [topics.platformActivity()] } });
    expect(log.error).toHaveBeenCalledWith("Live activity publish failed:", "cs101", expect.any(Error));
  });

  it("publishes a course notice on its topic, and reports what it could not", async () => {
    const hub = memoryRealtimeHub();
    const heard: unknown[] = [];
    await hub.subscribe("snippets:cs101", (m) => heard.push(m));
    const ping = { type: "gist-created", id: "g1", courseId: "cs101", sentAt: 1 } as CourseNotice;
    expect(await publishNotice(hub, ping)).toBe(true);
    expect(heard).toEqual([{ event: "gist-created", payload: ping }]);
    expect(await publishNotice(null, ping)).toBe(false);
    expect(await publishNotice(hub, { ...ping, courseId: "" })).toBe(false);
    expect(await publishNotice({ ...hub, publish: () => Promise.reject(new Error("down")) }, ping)).toBe(false);
  });
});

describe("publishBrowserMessage", () => {
  const body = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({ topic: "playground:cs101:/lab/1", event: "state", payload: { studentId: "ann" }, from: "tab-1", ...overrides });
  const always = () => true;
  const educators = ["eve"];
  const as = (login: string) => ({ login, isEducator: async (courseId: string) => courseId === "cs101" && educators.includes(login) });

  it("publishes a student's own state and an educator's watching, with the tab it came from", async () => {
    const hub = memoryRealtimeHub();
    const heard: unknown[] = [];
    await hub.subscribe("playground:cs101:/lab/1", (m) => heard.push(m));
    expect(await publishBrowserMessage(body(), hub, always, as("ann"))).toEqual({ status: 202 });
    expect(await publishBrowserMessage(body({ event: "watching", payload: undefined, from: "x".repeat(65) }), hub, always, as("eve"))).toEqual({ status: 202 });
    expect(heard).toEqual([
      { event: "state", payload: { studentId: "ann" }, from: "tab-1" },
      { event: "watching", payload: {} }
    ]);
  });

  it("refuses anything but a playground share's two events, from anyone but who they need", async () => {
    const hub = memoryRealtimeHub();
    const ann = as("ann");
    expect((await publishBrowserMessage("x".repeat(MAX_BROWSER_MESSAGE_BYTES + 1), hub, always, ann)).status).toBe(413);
    expect((await publishBrowserMessage("{", hub, always, ann)).status).toBe(400);
    expect((await publishBrowserMessage("null", hub, always, ann)).status).toBe(400);
    expect((await publishBrowserMessage(body({ topic: "broadcast:cs101" }), hub, always, ann)).status).toBe(403);
    expect((await publishBrowserMessage(body({ event: "lo-event" }), hub, always, ann)).status).toBe(400);
    expect((await publishBrowserMessage(body(), hub, always, as("mallory"))).status).toBe(403);
    expect((await publishBrowserMessage(body({ payload: null }), hub, always, ann)).status).toBe(403);
    expect((await publishBrowserMessage(body({ event: "watching" }), hub, always, ann)).status).toBe(403);
    expect((await publishBrowserMessage(body(), hub, () => false, ann)).status).toBe(429);
    expect((await publishBrowserMessage(body(), { ...hub, publish: () => Promise.reject(new Error("down")) }, always, ann)).status).toBe(502);
  });

  it("limits each sender on a topic, not the class sharing it", async () => {
    const hub = memoryRealtimeHub();
    const keys: string[] = [];
    await publishBrowserMessage(body(), hub, (key) => (keys.push(key), true), as("ann"));
    expect(keys).toEqual(["playground:cs101:/lab/1|ann"]);
  });

  it("limits each key to its messages per second", () => {
    let now = 0;
    const allow = topicRateLimiter(2, () => now);
    expect([allow("a"), allow("a"), allow("a"), allow("b")]).toEqual([true, true, false, true]);
    now = 1000;
    expect(allow("a")).toBe(true);
  });
});

/** A fake EventSource wired straight to a hub, as the stream route wires a browser to the server's hub. */
function hubEventSource(hub: RealtimeHub, opened: FakeSource[] = []) {
  return (url: string): EventSourceLike => {
    const topic = new URL(url, "https://reader.test").searchParams.get("topic")!;
    const source = new FakeSource(url);
    opened.push(source);
    void hub
      .subscribe(topic, (message) => source.onmessage?.({ data: JSON.stringify(message) }))
      .then((leave) => {
        source.leave = leave;
        source.onopen?.({});
      });
    return source;
  };
}

class FakeSource implements EventSourceLike {
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  closed = false;
  leave: () => Promise<void> = async () => {};
  constructor(readonly url: string) {}
  close() {
    this.closed = true;
    void this.leave();
  }
}

/** `fetch` for a tab's sends: POST /api/realtime/publish into the same hub. */
function publishFetch(hub: RealtimeHub): typeof fetch {
  return (async (_url: string, init: RequestInit) => {
    // Signed in as whoever the message needs: the student it names, or an educator watching.
    const login = (JSON.parse(String(init.body)) as { payload?: { studentId?: string } }).payload?.studentId ?? "eve";
    const result = await publishBrowserMessage(String(init.body), hub, () => true, { login, isEducator: async () => true });
    return new Response(null, { status: result.status });
  }) as typeof fetch;
}

/** One tab on the server's hub. */
const tabOn = (hub: RealtimeHub) => createRealtimeGateway({ adapter: sseRealtimeAdapter({ eventSource: hubEventSource(hub), fetch: publishFetch(hub) }) });

function playgroundTabs(): PlaygroundLive {
  const hub = memoryRealtimeHub();
  const student = valkeyPlaygroundLive(tabOn(hub));
  const lecturer = valkeyPlaygroundLive(tabOn(hub));
  return { share: student.share.bind(student), watch: lecturer.watch.bind(lecturer) };
}

contract("PlaygroundLive: Valkey", playgroundLiveContract(playgroundTabs), {
  // As on Supabase: the watcher announces itself on a 250 ms poll; covered below with a controlled clock.
  "a lecturer's arrival is announced to the students sharing": "announcement polls on a 250 ms interval",
  // A stream is live only once the server answers, after the contract's synchronous send; covered below once it is.
  "a sharing student's state reaches a lecturer watching the same exercise, and no other": "a share's stream opens asynchronously"
});

contract(
  "CourseNotices: Valkey",
  courseNoticesContract(() => {
    const hub = memoryRealtimeHub();
    return valkeyCourseNotices(tabOn(hub), { post: (notice) => publishNotice(hub, notice) });
  })
);

describe("the browser's realtime on Valkey", () => {
  it("delivers a sharing student's state to a lecturer watching the same exercise, and no other, once the share is live", async () => {
    const live = playgroundTabs();
    const seen: string[] = [];
    const elsewhere: string[] = [];
    const stopWatching = live.watch("cs101", "/lab/hello", (s) => seen.push(s.studentId));
    const stopOther = live.watch("cs101", "/lab/other", (s) => elsewhere.push(s.studentId));
    const share = live.share("cs101", "/lab/hello", () => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    share.send({ studentId: "ada", studentName: "Ada", files: [], activePath: "main.py", output: "", running: false, updatedAt: "2026-09-10T09:00:00.000Z" });
    await vi.waitFor(() => expect(seen).toEqual(["ada"]));
    expect(elsewhere).toEqual([]);
    share.stop();
    stopWatching();
    stopOther();
  });

  it("announces a lecturer to the sharing student once the stream is live", async () => {
    vi.useFakeTimers();
    const hub = memoryRealtimeHub();
    const onWatcher = vi.fn();
    const share = valkeyPlaygroundLive(tabOn(hub)).share("cs101", "/lab/1", onWatcher);
    const stop = valkeyPlaygroundLive(tabOn(hub)).watch("cs101", "/lab/1", () => {});
    await vi.advanceTimersByTimeAsync(1000);
    expect(onWatcher).toHaveBeenCalledOnce();
    stop();
    stop();
    share.stop();
    share.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(hub.subscribed()).toEqual([]);
  });

  it("drops the tab's own sends unless it joined with self, and frames that are not messages", async () => {
    const opened: FakeSource[] = [];
    const hub = memoryRealtimeHub();
    const adapter = sseRealtimeAdapter({ clientId: "tab-1", eventSource: hubEventSource(hub, opened), fetch: publishFetch(hub) });
    const own: string[] = [];
    const withSelf: string[] = [];
    const statuses: string[] = [];
    const channel = adapter.join(
      "playground:cs101:/lab/1" as never,
      { self: false },
      (event) => own.push(event),
      (status) => statuses.push(status)
    );
    adapter.join(
      "playground:cs101:/lab/1" as never,
      { self: true },
      (event) => withSelf.push(event),
      () => {}
    );
    await vi.waitFor(() => expect(statuses).toEqual(["SUBSCRIBED"]));

    await channel.send("state", { studentId: "ann" });
    await hub.publish("playground:cs101:/lab/1", { event: "watching", payload: {}, from: "tab-2" });
    opened[0].onmessage?.({ data: "not json" });
    opened[0].onmessage?.({ data: JSON.stringify({ payload: 1 }) });
    expect(own).toEqual(["watching"]);
    expect(withSelf).toEqual(["state", "watching"]);

    await channel.leave();
    opened[0].onmessage?.({ data: JSON.stringify({ event: "late" }) });
    opened[0].onerror?.({});
    expect(own).toEqual(["watching"]);
    expect(statuses).toEqual(["SUBSCRIBED"]);
  });

  it("reports a stream that fails once, and a send the server refused", async () => {
    const opened: FakeSource[] = [];
    const refusing = (async () => new Response(null, { status: 403 })) as unknown as typeof fetch;
    const adapter = sseRealtimeAdapter({
      streamBase: "https://reader.test/",
      publishBase: "https://reader.test/",
      eventSource: hubEventSource(memoryRealtimeHub(), opened),
      fetch: refusing
    });
    const statuses: string[] = [];
    adapter.join(
      "cs101" as never,
      { self: false },
      () => {},
      (status) => statuses.push(status)
    );
    expect(opened[0].url).toBe("https://reader.test/api/realtime/stream?topic=cs101");
    opened[0].onerror?.({});
    opened[0].onerror?.({});
    opened[0].onopen?.({});
    expect(statuses).toEqual(["CHANNEL_ERROR"]);
    expect(opened[0].closed).toBe(true);
    await expect(adapter.publish("playground:cs101:/lab/1" as never, "state", {})).rejects.toThrow("POST /api/realtime/publish answered 403");
  });

  it("stays joining where there is no EventSource, as in a server render", () => {
    vi.stubGlobal("EventSource", undefined);
    const statuses: string[] = [];
    const channel = sseRealtimeAdapter().join(
      "cs101" as never,
      { self: false },
      () => {},
      (status) => statuses.push(status)
    );
    void channel.leave();
    expect(statuses).toEqual([]);
  });

  it("opens the browser's EventSource on the stream route", () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "EventSource",
      class {
        onopen = null;
        onmessage = null;
        onerror = null;
        constructor(url: string) {
          urls.push(url);
        }
        close() {}
      }
    );
    valkeyBrowserRealtime({ streamBase: "https://reader.test" }).notices.watch("cs101", "gist-created", () => {});
    expect(urls).toEqual(["https://reader.test/api/realtime/stream?topic=snippets%3Acs101"]);
  });

  it("logs a send that failed and a notice post that failed", async () => {
    vi.stubGlobal("EventSource", undefined);
    const realtime = valkeyBrowserRealtime({ fetch: (async () => new Response(null, { status: 502 })) as unknown as typeof fetch });
    realtime.gateway.publish("playground:cs101:/lab/1" as never, "state", {});
    await vi.waitFor(() => expect(log.error).toHaveBeenCalledWith("Realtime send failed:", "playground:cs101:/lab/1", expect.any(Error)));

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    expect(await realtime.notices.post({ type: "gist-created", id: "g1", courseId: "cs101", sentAt: 1 } as CourseNotice)).toBe(false);
    expect(await realtime.notices.post({ type: "gist-created", id: "g1", courseId: "", sentAt: 1 } as CourseNotice)).toBe(false);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 202 })));
    expect(await realtime.notices.post({ type: "gist-created", id: "g1", courseId: "cs101", sentAt: 1 } as CourseNotice)).toBe(true);
    expect(fetch).toHaveBeenCalledWith("/api/notices", expect.objectContaining({ method: "POST" }));
  });
});

describe("valkeyPresence", () => {
  const event = (courseId: string, id: string): PresenceEvent =>
    ({ courseId, courseUrl: "", courseTitle: "", loRoute: "/lab/1", title: "Lab 1", isPrivate: false, user: { id, fullName: id }, type: "lab" }) as PresenceEvent;

  it("reports and stores each event, and a Live tab hears the course's activity from the stream", async () => {
    const hub = memoryRealtimeHub();
    const reported: PresenceEvent[] = [];
    const stored: PresenceEvent[] = [];
    const reader = valkeyPresence(tabOn(hub), { report: (e) => reported.push(e), store: async (e) => void stored.push(e) });
    const live = valkeyPresence(tabOn(hub));
    const heard: string[] = [];
    const platform: string[] = [];
    const stop = live.subscribe((e) => heard.push(e.user!.id), "cs101");
    live.subscribe((e) => platform.push(e.user!.id));

    await reader.publish(event("cs101", "ann"));
    await reader.publish(event("", "nobody"));
    expect(reported.map((e) => e.user!.id)).toEqual(["ann", "nobody"]);
    expect(stored.map((e) => e.user!.id)).toEqual(["ann"]);

    await vi.waitFor(() => expect(hub.subscribed().sort()).toEqual(["cs101", topics.platformActivity()].sort()));
    await publishLiveActivity(JSON.stringify(event("cs101", "ann")), hub);
    await hub.publish("cs101", { event: "lo-event", payload: undefined });
    await hub.publish("cs101", { event: "other", payload: event("cs101", "bob") });
    expect(heard).toEqual(["ann"]);
    expect(platform).toEqual(["ann"]);
    stop();
    stop();
    await vi.waitFor(() => expect(hub.subscribed()).toEqual([topics.platformActivity()]));
  });

  it("reads the roster through the data API, and logs a snapshot it could not store", async () => {
    const roster = vi.fn(async () => [{ payload: event("cs101", "ann") }] as never);
    const presence = valkeyPresence(tabOn(memoryRealtimeHub()), { report: () => {}, roster, store: () => Promise.reject(new Error("503")) });
    expect(await presence.recent(" cs101 ", "2026-01-01T00:00:00.000Z")).toHaveLength(1);
    expect(roster).toHaveBeenCalledWith("cs101", "2026-01-01T00:00:00.000Z");
    expect(await presence.recent("", "x")).toEqual([]);
    expect(await valkeyPresence(tabOn(memoryRealtimeHub())).recent("cs101", "x")).toBeNull();
    await presence.publish(event("cs101", "ann"));
    expect(log.error).toHaveBeenCalledWith("Storing the latest presence snapshot failed:", expect.any(Error));
  });

  it("posts each event to the reader's server with keepalive by default, and logs a post that failed", async () => {
    const post = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", post);
    const presence = valkeyPresence(tabOn(memoryRealtimeHub()));
    await presence.publish(event("cs101", "ann"));
    expect(post).toHaveBeenCalledWith("/api/live/activity", expect.objectContaining({ method: "POST", keepalive: true }));

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await presence.publish(event("cs101", "ann"));
    await vi.waitFor(() => expect(log.warn).toHaveBeenCalledWith("Reporting live activity failed:", expect.any(Error)));
    vi.stubGlobal("fetch", () => {
      throw new Error("sync");
    });
    await presence.publish(event("cs101", "ann"));
    vi.stubGlobal("fetch", undefined);
    await presence.publish(event("cs101", "ann"));
  });
});

describe("connectValkey", () => {
  // The adapter imports `redis` lazily from its own package, so the mock is registered for the module that import resolves to.
  const redisEntry = createRequire(resolve(__dirname, "../../../packages/adapters/driven/realtime-valkey/package.json")).resolve("redis");

  afterEach(() => {
    vi.doUnmock(redisEntry);
    vi.resetModules();
  });

  it("connects a publisher and its duplicate for SUBSCRIBE, each logging its connection errors", async () => {
    const made: { on: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn>; duplicate: () => unknown }[] = [];
    const client = () => {
      const c = { on: vi.fn(), connect: vi.fn(async () => undefined), duplicate: () => client() };
      made.push(c);
      return c;
    };
    const createClient = vi.fn(client);
    vi.doMock(redisEntry, () => ({ createClient, default: { createClient } }));

    const { publisher, subscriber } = await connectValkey("redis://valkey.internal:6379");

    expect(createClient).toHaveBeenCalledWith({ url: "redis://valkey.internal:6379" });
    expect([publisher, subscriber]).toEqual(made);
    for (const c of made) {
      expect(c.connect).toHaveBeenCalledOnce();
      c.on.mock.calls[0][1](new Error("ECONNRESET"));
    }
    expect(made[0].on).toHaveBeenCalledWith("error", expect.any(Function));
    expect(log.warn).toHaveBeenCalledWith("Valkey publisher connection error:", expect.any(Error));
    expect(log.warn).toHaveBeenCalledWith("Valkey subscriber connection error:", expect.any(Error));
  });

  it("says which package is missing when the driver cannot be imported", async () => {
    vi.doMock(redisEntry, () => {
      throw new Error("Cannot find package 'redis'");
    });
    await expect(connectValkey("redis://valkey.internal:6379")).rejects.toThrow(/needs the `redis` package/);
  });
});
