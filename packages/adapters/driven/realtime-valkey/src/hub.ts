/**
 * The server side of realtime: a hub every server process shares. A server publishes a message to
 * a topic; each server that has a browser streaming that topic subscribes to it once and fans the
 * message out over its server-sent event streams (stream.ts). On Valkey the topic is a pub/sub
 * channel, so the reader's server can publish what Tutors Live's server streams. Fan-out costs
 * nothing per message, which is why there is no daily budget here.
 */
import log from "@tutors/logger";
import { connectValkey, type PubSubPair } from "./client.ts";

/** What travels on a topic: the event name, its payload, and the tab that sent it (browser sends only). */
export type HubMessage = { event: string; payload: unknown; from?: string };

export type HubListener = (message: HubMessage) => void;

export interface RealtimeHub {
  readonly kind: "valkey" | "memory";
  publish(topic: string, message: HubMessage): Promise<void>;
  /** Resolves once the hub is subscribed, so a message published after it is delivered. */
  subscribe(topic: string, listener: HubListener): Promise<() => Promise<void>>;
  /** The topics this process is subscribed to: one per topic, however many streams share it. */
  subscribed(): string[];
  close(): Promise<void>;
}

/** Valkey channels carry a prefix, so realtime topics never collide with another user of the same Valkey. */
export const CHANNEL_PREFIX = "tutors:rt:";

function decode(raw: string): HubMessage | null {
  try {
    const message = JSON.parse(raw) as Partial<HubMessage> | null;
    if (!message || typeof message.event !== "string") return null;
    return { event: message.event, payload: message.payload, ...(typeof message.from === "string" ? { from: message.from } : {}) };
  } catch {
    return null;
  }
}

/** Calls every listener of a topic; a listener that throws never stops the others. */
function deliver(listeners: Set<HubListener> | undefined, message: HubMessage): void {
  for (const listener of listeners ?? []) {
    try {
      listener(message);
    } catch (error) {
      log.error("A realtime listener failed:", error);
    }
  }
}

/** One process only: what a server publishes reaches the streams of that same server. For tests and a single-process dev server. */
export function memoryRealtimeHub(): RealtimeHub {
  const topics = new Map<string, Set<HubListener>>();
  return {
    kind: "memory",
    async publish(topic, message) {
      deliver(topics.get(topic), message);
    },
    async subscribe(topic, listener) {
      const listeners = topics.get(topic) ?? new Set<HubListener>();
      topics.set(topic, listeners);
      listeners.add(listener);
      return async () => {
        listeners.delete(listener);
        if (listeners.size === 0) topics.delete(topic);
      };
    },
    subscribed: () => [...topics.keys()],
    async close() {
      topics.clear();
    }
  };
}

/**
 * The hub over Valkey pub/sub. One SUBSCRIBE per topic per process, however many browsers stream
 * it: the first listener subscribes, the last one leaving unsubscribes. `connect` is called once, on
 * first use, so composing the hub opens no connection.
 */
export function valkeyRealtimeHub(connect: () => Promise<PubSubPair>): RealtimeHub {
  let connection: Promise<PubSubPair> | undefined;
  const pair = () => {
    connection ??= connect().catch((error: unknown) => {
      connection = undefined;
      throw error;
    });
    return connection;
  };
  const topics = new Map<string, { listeners: Set<HubListener>; ready: Promise<unknown> }>();
  /** UNSUBSCRIBEs still in flight; a new SUBSCRIBE to the same topic waits for them, or it would be undone. */
  const leaving = new Map<string, Promise<void>>();

  return {
    kind: "valkey",

    async publish(topic, message) {
      const { publisher } = await pair();
      await publisher.publish(CHANNEL_PREFIX + topic, JSON.stringify(message));
    },

    async subscribe(topic, listener) {
      let entry = topics.get(topic);
      if (!entry) {
        const listeners = new Set<HubListener>();
        const ready = Promise.all([pair(), leaving.get(topic)]).then(([{ subscriber }]) =>
          subscriber.subscribe(CHANNEL_PREFIX + topic, (raw) => {
            const message = decode(raw);
            if (message) deliver(listeners, message);
          })
        );
        entry = { listeners, ready };
        topics.set(topic, entry);
        ready.catch(() => {
          if (topics.get(topic) === entry) topics.delete(topic);
        });
      }
      const current = entry;
      current.listeners.add(listener);
      try {
        await current.ready;
      } catch (error) {
        current.listeners.delete(listener);
        throw error;
      }
      let open = true;
      return async () => {
        if (!open) return;
        open = false;
        current.listeners.delete(listener);
        if (current.listeners.size > 0 || topics.get(topic) !== current) return;
        topics.delete(topic);
        const done = (async () => {
          await leaving.get(topic)?.catch(() => undefined);
          const { subscriber } = await pair();
          await subscriber.unsubscribe(CHANNEL_PREFIX + topic);
        })();
        const settled = done.catch(() => undefined);
        leaving.set(topic, settled);
        void settled.then(() => {
          if (leaving.get(topic) === settled) leaving.delete(topic);
        });
        await done;
      };
    },

    subscribed: () => [...topics.keys()],

    async close() {
      topics.clear();
      if (!connection) return;
      const { publisher, subscriber } = await connection.catch(() => ({ publisher: null, subscriber: null }));
      connection = undefined;
      await Promise.allSettled([publisher?.quit(), subscriber?.quit()]);
    }
  };
}

const hubs = new Map<string, RealtimeHub>();

/**
 * The process's hub for `url`: one Valkey hub per URL for the server's lifetime, or, with no URL,
 * the process-wide memory hub (one server process in dev: what it publishes, it streams).
 */
export function realtimeHub(url: string | undefined): RealtimeHub {
  const key = url?.trim() ?? "";
  let hub = hubs.get(key);
  if (!hub) {
    hub = key ? valkeyRealtimeHub(() => connectValkey(key)) : memoryRealtimeHub();
    hubs.set(key, hub);
  }
  return hub;
}
