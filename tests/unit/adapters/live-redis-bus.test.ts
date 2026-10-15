/**
 * The LiveBus over Redis Streams, against a fake stream that behaves like XADD/XREAD BLOCK.
 *
 * What it must get right: a subscriber hears only what is published after it subscribed, every
 * event arrives once and in order, a malformed entry is reported and skipped rather than ending the
 * loop, a broker that fails is reported and retried, and stopping (one subscriber, or the bus) means
 * no more deliveries.
 */
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveEvent } from "@tutors/domain/live";
import { connectRedis, LIVE_STREAM, redisLiveBus, type RedisClient } from "@tutors/live-redis";

type Entry = { id: string; message: Record<string, string> };

/**
 * A Redis stream and the two commands the bus uses. XREAD with `$` starts after the newest entry,
 * and a read with nothing new waits up to BLOCK ms for an append before answering null.
 */
function fakeStreams() {
  const streams = new Map<string, Entry[]>();
  const waiting = new Set<() => void>();
  let sequence = 0;
  const of = (key: string) => {
    const entries = streams.get(key) ?? [];
    streams.set(key, entries);
    return entries;
  };
  const after = (key: string, id: string) => of(key).filter((entry) => Number(entry.id.split("-")[0]) > Number(id.split("-")[0]));
  const reads: { key: string; id: string; options?: { BLOCK?: number; COUNT?: number } }[] = [];

  const client = {
    async xAdd(key: string, id: string, message: Record<string, string>) {
      expect(id).toBe("*");
      const entry = { id: `${++sequence}-0`, message };
      of(key).push(entry);
      for (const wake of [...waiting]) wake();
      return entry.id;
    },
    async xRead(request: { key: string; id: string } | { key: string; id: string }[], options?: { BLOCK?: number; COUNT?: number }) {
      const { key, id: requested } = Array.isArray(request) ? request[0] : request;
      reads.push({ key, id: requested, options });
      const id = requested === "$" ? (of(key).at(-1)?.id ?? "0-0") : requested;
      const ready = () => after(key, id).slice(0, options?.COUNT ?? Infinity);
      if (ready().length === 0) {
        await new Promise<void>((done) => {
          const wake = () => {
            waiting.delete(wake);
            clearTimeout(timer);
            done();
          };
          const timer = setTimeout(wake, options?.BLOCK ?? 0);
          waiting.add(wake);
        });
      }
      const messages = ready();
      return messages.length ? [{ name: key, messages }] : null;
    }
  };
  return { client: client as unknown as RedisClient, streams, reads, raw: (key: string, message: Record<string, string>) => client.xAdd(key, "*", message) };
}

const ts = "2026-09-17T10:00:00.000Z";
const opened = (sid: string, course = "cs101"): LiveEvent => ({ type: "course.opened", ts, sid, course });
const viewed = (sid: string, lo: string): LiveEvent => ({ type: "lo.viewed", ts, sid, course: "cs101", lo, loType: "lab" });

/** Resolves once `count` events have been heard, or fails the test after a second. */
function collector() {
  const heard: LiveEvent[] = [];
  const waiters: { count: number; done: () => void }[] = [];
  const handler = async (event: LiveEvent) => {
    heard.push(event);
    for (const waiter of [...waiters]) if (heard.length >= waiter.count) waiter.done();
  };
  const until = (count: number) =>
    heard.length >= count
      ? Promise.resolve()
      : new Promise<void>((done, fail) => {
          const timer = setTimeout(() => fail(new Error(`heard ${heard.length} of ${count}`)), 1000);
          waiters.push({ count, done: () => (clearTimeout(timer), done()) });
        });
  return { heard, handler, until };
}

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

describe("redisLiveBus", () => {
  it("is the redis bus, and appends each event to the live stream with its type and JSON body", async () => {
    const { client, streams } = fakeStreams();
    const bus = redisLiveBus({ client });
    expect(bus.kind).toBe("redis");

    await bus.publish([opened("s1"), viewed("s1", "/lab/1")]);

    expect(LIVE_STREAM).toBe("tutors.live.events");
    const entries = streams.get(LIVE_STREAM) ?? [];
    expect(entries.map((entry) => entry.message.type)).toEqual(["course.opened", "lo.viewed"]);
    expect(JSON.parse(entries[1].message.event)).toEqual(viewed("s1", "/lab/1"));
  });

  it("delivers, in order, only what is published after subscribing", async () => {
    const { client } = fakeStreams();
    const bus = redisLiveBus({ client, blockMs: 20 });
    await bus.publish([opened("before")]);

    const { heard, handler, until } = collector();
    const stop = await bus.subscribe(handler);
    await bus.publish([opened("s1")]);
    await bus.publish([viewed("s1", "/lab/1"), viewed("s1", "/lab/2")]);
    await until(3);

    expect(heard.map((event) => event.sid)).toEqual(["s1", "s1", "s1"]);
    expect(heard.map((event) => event.type)).toEqual(["course.opened", "lo.viewed", "lo.viewed"]);
    await stop();
  });

  it("reads with its own connection when given one, from the stream it was configured with, in blocking batches", async () => {
    const publisher = fakeStreams();
    const reader = fakeStreams();
    const bus = redisLiveBus({ client: publisher.client, reader: reader.client, stream: "custom", blockMs: 10 });
    const { heard, handler, until } = collector();
    const stop = await bus.subscribe(handler);

    // The reader is the connection that is blocked on XREAD, so the event must reach its stream.
    await reader.raw("custom", { type: "course.opened", event: JSON.stringify(opened("s9")) });
    await until(1);

    expect(heard[0].sid).toBe("s9");
    expect(publisher.reads).toEqual([]);
    expect(reader.reads[0]).toEqual({ key: "custom", id: "$", options: { BLOCK: 10, COUNT: 100 } });
    // The next read resumes after the entry just delivered, so nothing is heard twice.
    await pause(15);
    expect(reader.reads.slice(1).every((read) => read.id === "1-0")).toBe(true);
    expect(heard).toHaveLength(1);
    await stop();
  });

  it("reports and skips a malformed entry, then carries on with the next", async () => {
    const { client, raw } = fakeStreams();
    const errors: unknown[] = [];
    const bus = redisLiveBus({ client, blockMs: 10, onError: (error) => errors.push(error) });
    const { heard, handler, until } = collector();
    const stop = await bus.subscribe(handler);

    await raw(LIVE_STREAM, { type: "course.opened", event: "{not json" });
    await raw(LIVE_STREAM, { type: "course.opened" });
    await raw(LIVE_STREAM, { type: "nonsense", event: JSON.stringify({ type: "nonsense" }) });
    await bus.publish([opened("good")]);
    await until(1);

    expect(heard.map((event) => event.sid)).toEqual(["good"]);
    expect(errors).toHaveLength(3);
    expect(String(errors[0])).toContain(`dropped a malformed event from ${LIVE_STREAM}`);
    expect(String(errors[2])).toContain("unknown type: nonsense");
    await stop();
  });

  it("reports a failing broker, backs off, and reads again", async () => {
    const { client } = fakeStreams();
    const real = client.xRead.bind(client);
    let failures = 1;
    const xRead = vi.fn(async (...args: Parameters<RedisClient["xRead"]>) => {
      if (failures-- > 0) throw new Error("connection reset");
      return real(...args);
    });
    const flaky = { ...client, xRead } as RedisClient;
    const errors: unknown[] = [];
    const bus = redisLiveBus({ client: flaky, blockMs: 5, onError: (error) => errors.push(error) });
    const { heard, handler, until } = collector();
    const stop = await bus.subscribe(handler);
    await pause(20);

    await bus.publish([opened("after-outage")]);
    await until(1);

    expect(errors.map(String)).toEqual(["Error: connection reset"]);
    expect(heard[0].sid).toBe("after-outage");
    expect(xRead.mock.calls.length).toBeGreaterThan(1);
    await stop();
  });

  it("does not report a read that fails because the subscriber has already stopped", async () => {
    let failRead: (error: Error) => void = () => {};
    const reader = {
      xRead: vi.fn(() => new Promise((_, reject) => (failRead = reject)))
    } as unknown as RedisClient;
    const onError = vi.fn();
    const bus = redisLiveBus({ client: fakeStreams().client, reader, onError });
    const stop = await bus.subscribe(async () => {});

    await stop();
    failRead(new Error("socket closed by quit"));
    await pause(5);

    expect(onError).not.toHaveBeenCalled();
    expect(reader.xRead).toHaveBeenCalledTimes(1);
  });

  it("stops delivering to a subscriber that unsubscribed, while the others keep hearing", async () => {
    const { client } = fakeStreams();
    const bus = redisLiveBus({ client, blockMs: 5 });
    const leaving = collector();
    const staying = collector();
    const stopLeaving = await bus.subscribe(leaving.handler);
    const stopStaying = await bus.subscribe(staying.handler);

    await bus.publish([opened("s1")]);
    await Promise.all([leaving.until(1), staying.until(1)]);
    await stopLeaving();
    await pause(15);
    await bus.publish([opened("s2")]);
    await staying.until(2);
    await pause(15);

    expect(leaving.heard.map((event) => event.sid)).toEqual(["s1"]);
    expect(staying.heard.map((event) => event.sid)).toEqual(["s1", "s2"]);
    await stopStaying();
  });

  it("stops every subscriber when the bus is closed", async () => {
    const { client } = fakeStreams();
    const bus = redisLiveBus({ client, blockMs: 5 });
    const a = collector();
    const b = collector();
    await bus.subscribe(a.handler);
    await bus.subscribe(b.handler);

    await bus.close();
    await pause(15);
    await bus.publish([opened("late")]);
    await pause(15);

    expect(a.heard).toEqual([]);
    expect(b.heard).toEqual([]);
  });
});

describe("connectRedis", () => {
  // The adapter imports `redis` lazily from its own package, so the mock is registered for the module that import resolves to.
  const redisEntry = createRequire(resolve(__dirname, "../../../packages/adapters/driven/live-redis/package.json")).resolve("redis");

  afterEach(() => {
    vi.doUnmock(redisEntry);
    vi.resetModules();
  });

  it("creates a client for the URL and connects it before handing it over", async () => {
    const connect = vi.fn(async () => undefined);
    const createClient = vi.fn(() => ({ connect }));
    vi.doMock(redisEntry, () => ({ createClient, default: { createClient } }));

    const client = await connectRedis("redis://valkey.internal:6379");

    expect(createClient).toHaveBeenCalledWith({ url: "redis://valkey.internal:6379" });
    expect(connect).toHaveBeenCalledOnce();
    expect(client).toBe(createClient.mock.results[0].value);
  });

  it("says which package is missing when the driver cannot be imported", async () => {
    vi.doMock(redisEntry, () => {
      throw new Error("Cannot find package 'redis'");
    });

    await expect(connectRedis("redis://valkey.internal:6379")).rejects.toThrow(/need the `redis` package/);
  });
});
