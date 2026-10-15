/**
 * The browser's broker adapter for the @tutors/realtime gateway when realtime is Valkey: joining a
 * topic opens an EventSource on a Tutors server's GET /api/realtime/stream?topic=, and a send is a
 * POST to the reader's /api/realtime/publish. Like the Supabase adapter it translates and holds no
 * policy: a failed stream is closed and reported, so the gateway's jittered backoff decides when to
 * rejoin, not the EventSource's fixed retry.
 */
import type { RealtimeAdapter } from "@tutors/realtime";
import type { HubMessage } from "./hub.ts";

export const REALTIME_STREAM_ROUTE = "/api/realtime/stream";
export const REALTIME_PUBLISH_ROUTE = "/api/realtime/publish";

/** The slice of EventSource the adapter uses, so a test can hand it a fake. */
export interface EventSourceLike {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  close(): void;
}

export type SseAdapterOptions = {
  /** Where the stream is served: "" for this page's own server, or another Tutors app's origin (the reader's, for Tutors Time). */
  streamBase?: string;
  /** Where sends are posted: the reader, which publishes them. "" for this page's own server. */
  publishBase?: string;
  /** This tab's id, so a join without `self` drops the tab's own sends. */
  clientId?: string;
  eventSource?: (url: string) => EventSourceLike;
  fetch?: typeof fetch;
};

function parse(data: string): HubMessage | null {
  try {
    const message = JSON.parse(data) as Partial<HubMessage> | null;
    return message && typeof message.event === "string" ? (message as HubMessage) : null;
  } catch {
    return null;
  }
}

/** A server render has no EventSource: the link stays joining and nothing is delivered. */
function openEventSource(url: string): EventSourceLike {
  if (typeof EventSource === "undefined") return { onopen: null, onmessage: null, onerror: null, close: () => {} };
  return new EventSource(url) as unknown as EventSourceLike;
}

export function sseRealtimeAdapter(options: SseAdapterOptions = {}): RealtimeAdapter {
  const clientId = options.clientId ?? globalThis.crypto.randomUUID();
  const open = options.eventSource ?? openEventSource;
  const streamBase = (options.streamBase ?? "").replace(/\/+$/, "");
  const publishBase = (options.publishBase ?? "").replace(/\/+$/, "");

  const post = async (topic: string, event: string, payload: unknown) => {
    const send = options.fetch ?? fetch;
    const response = await send(`${publishBase}${REALTIME_PUBLISH_ROUTE}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic, event, payload, from: clientId })
    });
    if (!response.ok) throw new Error(`POST ${REALTIME_PUBLISH_ROUTE} answered ${response.status}`);
  };

  return {
    publish: post,

    join(topic, joinOptions, onMessage, onStatus) {
      const source = open(`${streamBase}${REALTIME_STREAM_ROUTE}?topic=${encodeURIComponent(topic)}`);
      let closed = false;
      source.onopen = () => {
        if (!closed) onStatus("SUBSCRIBED");
      };
      source.onerror = () => {
        if (closed) return;
        closed = true;
        source.close();
        onStatus("CHANNEL_ERROR");
      };
      source.onmessage = (frame) => {
        if (closed) return;
        const message = parse(frame.data);
        if (!message || (!joinOptions.self && message.from === clientId)) return;
        onMessage(message.event, message.payload);
      };
      return {
        send: (event, payload) => post(topic, event, payload),
        leave: async () => {
          closed = true;
          source.close();
        }
      };
    }
  };
}
