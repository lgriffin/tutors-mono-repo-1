import type { HubMessage, RealtimeHub } from "./hub.ts";

/**
 * One topic as server-sent events: the route GET /api/realtime/stream?topic= on the reader's and
 * Tutors Live's servers. The response is returned only once the hub is subscribed, so the browser's
 * `open` means "live" and nothing published after it is missed. Each message is one `data:` frame
 * holding the hub message as JSON; a comment every 25 seconds keeps a proxy from closing a quiet
 * stream. The stream ends when the browser goes away.
 */

/** Below a proxy's usual 30s idle timeout. */
export const KEEPALIVE_MS = 25_000;

export type StreamOptions = {
  /** Aborted when the browser closes the request. */
  signal?: AbortSignal;
  /** Extra response headers, such as CORS for another Tutors app's origin. */
  headers?: Record<string, string>;
  keepAliveMs?: number;
  /** Which messages this browser may see; the default sends every one. */
  only?: (message: HubMessage) => boolean;
};

export async function realtimeStream(hub: RealtimeHub, topic: string, options: StreamOptions = {}): Promise<Response> {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  /** Frames that arrive between the subscription and the stream starting. */
  const queued: Uint8Array[] = [];
  let closed = false;
  let keepAlive: ReturnType<typeof setInterval> | undefined;

  const write = (chunk: Uint8Array) => {
    if (closed) return;
    if (!controller) {
      queued.push(chunk);
      return;
    }
    try {
      controller.enqueue(chunk);
    } catch {
      // The browser went away between the check and the write.
      void stop();
    }
  };

  const unsubscribe = await hub.subscribe(topic, (message: HubMessage) => {
    if (!options.only || options.only(message)) write(encoder.encode(`data: ${JSON.stringify(message)}\n\n`));
  });

  async function stop(): Promise<void> {
    if (closed) return;
    closed = true;
    if (keepAlive) clearInterval(keepAlive);
    await unsubscribe();
    try {
      controller?.close();
    } catch {
      // Already closed by the platform.
    }
  }

  if (options.signal?.aborted) await stop();
  options.signal?.addEventListener("abort", () => void stop());

  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      if (closed) {
        c.close();
        return;
      }
      c.enqueue(encoder.encode(": subscribed\n\n"));
      for (const chunk of queued.splice(0)) c.enqueue(chunk);
      keepAlive = setInterval(() => write(encoder.encode(": keep-alive\n\n")), options.keepAliveMs ?? KEEPALIVE_MS);
    },
    cancel() {
      void stop();
    }
  });

  return new Response(body, {
    headers: {
      ...options.headers,
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      // Every deployment is behind a reverse proxy; nginx would otherwise buffer the stream.
      "x-accel-buffering": "no"
    }
  });
}
