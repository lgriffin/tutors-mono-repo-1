type BroadcastHandler = (payload: { payload: unknown }) => void;

export class MockRealtimeChannel {
  private broadcastHandlers: Map<string, BroadcastHandler[]> = new Map();
  private subscribed: boolean = false;

  on(type: "broadcast", filter: { event: string }, handler: BroadcastHandler): this {
    const handlers = this.broadcastHandlers.get(filter.event) || [];
    handlers.push(handler);
    this.broadcastHandlers.set(filter.event, handlers);
    return this;
  }

  subscribe(callback?: (status: string) => void): this {
    this.subscribed = true;
    if (callback) callback("SUBSCRIBED");
    return this;
  }

  send(_message: { type: string; event: string; payload: unknown }): void {}

  simulateBroadcast(event: string, data: unknown): void {
    const handlers = this.broadcastHandlers.get(event) || [];
    handlers.forEach(h => h({ payload: data }));
  }

  unsubscribe(): void {
    this.subscribed = false;
  }

  isSubscribed(): boolean {
    return this.subscribed;
  }
}

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;

export function createMockFetch(handlers: Record<string, FetchHandler | object>): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();

    for (const [pattern, handler] of Object.entries(handlers)) {
      if (url.includes(pattern)) {
        if (typeof handler === "function") {
          return handler(url, init);
        }
        return new Response(JSON.stringify(handler), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    return new Response("Not Found", { status: 404 });
  };
}
