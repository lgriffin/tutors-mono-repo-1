/**
 * The help queue's feed on Valkey: the server's feed over a hub keeps the AssistanceFeed contract,
 * a failed or missing hub publishes nothing, and an educator's browser hears the queue over a
 * server-sent event stream opened with the session and never publishes.
 */
import { describe, expect, it, vi } from "vitest";
import { assistanceFeedContract, type ContractCase } from "@tutors/application/testing";
import type { AssistanceChange } from "@tutors/application/ports";
import { openRequest } from "@tutors/domain/assistance";
import {
  assistanceCourseOf,
  assistanceTopic,
  memoryRealtimeHub,
  sseAssistanceFeed,
  streamableTopic,
  valkeyAssistanceFeed,
  type EventSourceLike,
  type RealtimeHub
} from "@tutors/realtime-valkey";

function contract(name: string, cases: ContractCase[]) {
  describe(name, () => {
    for (const c of cases) it(c.name, c.run);
  });
}

contract(
  "AssistanceFeed: Valkey (memory hub)",
  assistanceFeedContract(() => valkeyAssistanceFeed(memoryRealtimeHub()))
);

const change = (courseId: string, id = "h1"): AssistanceChange => ({
  type: "help-request",
  courseId,
  request: { ...openRequest({ courseId, labRoute: "/lab/cs101/lab-01", stepId: "02" }, { login: "alice", name: "Alice" }, "stuck", "2026-01-05T09:00:00.000Z"), id }
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the help queue topic", () => {
  it("is the course's assistance topic, streamable, and names its course", () => {
    expect(assistanceTopic("cs101")).toBe("assistance:cs101");
    expect(streamableTopic("assistance:cs101")).toBe("assistance:cs101");
    expect(assistanceCourseOf("assistance:cs101")).toBe("cs101");
  });

  it("refuses a topic that is not a course's help queue", () => {
    for (const raw of ["assistance:", "assistance:../x", "assistance:a:b", "broadcast:cs101", 7, null]) expect(assistanceCourseOf(raw)).toBeNull();
    expect(streamableTopic("assistance:a b")).toBeNull();
  });
});

describe("valkeyAssistanceFeed", () => {
  it("publishes nothing without a hub, and hears nothing", async () => {
    const feed = valkeyAssistanceFeed(null);
    const heard = vi.fn();
    feed.watch("cs101", heard)();
    expect(await feed.publish(change("cs101"))).toBe(false);
    expect(heard).not.toHaveBeenCalled();
  });

  it("answers false, logging, when Valkey refuses the publish", async () => {
    const hub = { ...memoryRealtimeHub(), publish: () => Promise.reject(new Error("down")) } as RealtimeHub;
    expect(await valkeyAssistanceFeed(hub).publish(change("cs101"))).toBe(false);
  });

  it("publishes the change as its type on the course's topic", async () => {
    const hub = memoryRealtimeHub();
    const messages: unknown[] = [];
    await hub.subscribe("assistance:cs101", (m) => messages.push(m));
    await valkeyAssistanceFeed(hub).publish(change("cs101"));
    expect(messages).toEqual([{ event: "help-request", payload: change("cs101") }]);
  });

  it("ignores a message on the topic that is not a change of that course", async () => {
    const hub = memoryRealtimeHub();
    const heard = vi.fn();
    valkeyAssistanceFeed(hub).watch("cs101", heard);
    await tick();
    await hub.publish("assistance:cs101", { event: "help-request", payload: { nonsense: true } });
    await hub.publish("assistance:cs101", { event: "help-request", payload: change("cs102") });
    expect(heard).not.toHaveBeenCalled();
  });

  it("keeps working when subscribing fails, and unsubscribes once", async () => {
    const hub = { ...memoryRealtimeHub(), subscribe: () => Promise.reject(new Error("down")) } as unknown as RealtimeHub;
    const stop = valkeyAssistanceFeed(hub).watch("cs101", vi.fn());
    await tick();
    expect(() => stop()).not.toThrow();
    await tick();
  });
});

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

describe("sseAssistanceFeed", () => {
  it("streams the course's queue from the reader and hears its changes", () => {
    const sources: FakeEventSource[] = [];
    const feed = sseAssistanceFeed({ streamBase: "https://reader.test//", eventSource: (url) => (sources.push(new FakeEventSource(url)), sources.at(-1)!) });
    const heard: AssistanceChange[] = [];
    const stop = feed.watch("cs101", (c) => heard.push(c));
    expect(sources[0].url).toBe("https://reader.test/api/realtime/stream?topic=assistance%3Acs101");
    sources[0].onmessage!({ data: JSON.stringify({ event: "help-request", payload: change("cs101") }) });
    sources[0].onmessage!({ data: JSON.stringify({ event: "help-request", payload: change("cs102") }) });
    sources[0].onmessage!({ data: "not json" });
    expect(heard).toEqual([change("cs101")]);
    stop();
    expect(sources[0].closed).toBe(true);
    sources[0].onmessage!({ data: JSON.stringify({ event: "help-request", payload: change("cs101", "h2") }) });
    expect(heard).toHaveLength(1);
  });

  it("never publishes from a browser", async () => {
    expect(await sseAssistanceFeed().publish(change("cs101"))).toBe(false);
  });

  it("opens nothing on a server render, where there is no EventSource", () => {
    vi.stubGlobal("EventSource", undefined);
    try {
      expect(() => sseAssistanceFeed().watch("cs101", vi.fn())()).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("opens the stream with the session", () => {
    const opened: [string, unknown][] = [];
    class RecordingEventSource {
      onmessage = null;
      constructor(url: string, init: unknown) {
        opened.push([url, init]);
      }
      close() {}
    }
    vi.stubGlobal("EventSource", RecordingEventSource);
    try {
      sseAssistanceFeed({ streamBase: "https://reader.test" }).watch("cs101", vi.fn())();
      expect(opened).toEqual([["https://reader.test/api/realtime/stream?topic=assistance%3Acs101", { withCredentials: true }]]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
