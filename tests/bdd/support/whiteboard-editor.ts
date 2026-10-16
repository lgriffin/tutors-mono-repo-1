import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { vi } from "vitest";

/** What the editor posted to the reader's POST /api/realtime/publish. */
type PublishedMessage = { topic: string; event: string; payload: Record<string, unknown>; from: string };

/** The room's own bookkeeping, as opposed to the collaboration broadcasts the editor sends. */
const ROOM_EVENTS = new Set(["presence", "leave"]);

/** A browser's EventSource on the room's stream (GET /api/realtime/stream?topic=), driven by the test. */
class RoomEventSource {
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {}
  close() {
    this.closed = true;
  }
}

/**
 * Execute the iframe's actual script with React hooks, the browser's EventSource and fetch as the
 * seams; no CDN or network. A shared board's room streams from the reader's server and posts what it
 * sends to the reader's publish route; the test opens, feeds and drops that stream.
 */
export function mountWhiteboardEditor(personal = false, userId = "alice") {
  const html = readFileSync("apps/reader/static/excalidraw-editor.html", "utf8");
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)![1].replace(/^\s*import .*;$/gm, "");
  const effects: (() => void | (() => void))[] = [];
  const sources: RoomEventSource[] = [];
  const published: PublishedMessage[] = [];
  const fetch = vi.fn(async (url: string, init: { method?: string; body?: string }) => {
    if (url === "/api/realtime/publish" && init?.method === "POST") published.push(JSON.parse(String(init.body)) as PublishedMessage);
    return { ok: true, status: 202 };
  });
  const postMessage = vi.fn();
  const OwnKey = "session-alice";
  const Editor = runInNewContext(`${script}\nExcalidrawEditor;`, {
    createElement: (_component: unknown, props: unknown) => props,
    Excalidraw: {},
    useRef: (current: unknown) => ({ current }),
    useState: (initial: unknown) => [initial, vi.fn()],
    useCallback: (callback: unknown) => callback,
    useEffect: (effect: () => void | (() => void)) => effects.push(effect),
    EventSource: function (url: string) {
      const source = new RoomEventSource(url);
      sources.push(source);
      return source;
    },
    fetch,
    Math,
    JSON,
    Map,
    Set,
    Object,
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn(), parent: { postMessage } },
    document: { getElementById: () => ({ classList: { add: vi.fn(), toggle: vi.fn() } }) },
    location: { origin: "https://reader.invalid" },
    crypto: { randomUUID: () => OwnKey },
    encodeURIComponent,
    // The test's clock, captured when the editor mounts, so fake timers drive the editor's timers and Date.now().
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date
  });
  const editor = Editor({
    config: {
      shared: !personal,
      roomId: "shared-board",
      user: { id: userId, name: userId, avatar: `${userId}.png` }
    }
  });
  const cleanups = effects.map((effect) => effect());
  postMessage.mockClear();

  /** The peers this test has announced in the room: presence key to user. */
  const peers = new Map<string, string>();
  const source = () => sources.at(-1);
  const deliver = (message: { event: string; payload: unknown; from: string }) => source()?.onmessage?.({ data: JSON.stringify(message) });

  return {
    editor,
    postMessage,
    /** Every stream the room opened. */
    sources,
    /** Everything the editor posted to the publish route, room bookkeeping included. */
    published,
    /** The collaboration broadcasts (scene and cursor updates) the editor posted, in order. */
    broadcasts: () => published.filter((message) => !ROOM_EVENTS.has(message.event)),
    /** The reader's server answers the room's stream: the editor is subscribed. */
    open: () => source()!.onopen?.({}),
    /** The room's stream fails, as a dropped connection does. */
    drop: () => source()!.onerror?.({}),
    /**
     * The room holds this editor and `count - 1` peers, announced or sent leaving over the stream; an
     * unchanged room still hears a peer's periodic presence, so the editor syncs presence either way.
     */
    participants: (count: number, sameUser = false) => {
      const wanted = new Set(Array.from({ length: Math.max(0, count - 1) }, (_, index) => `session-peer-${index + 1}`));
      for (const [key, user] of [...peers]) {
        if (wanted.has(key)) continue;
        peers.delete(key);
        deliver({ event: "leave", payload: { userId: user }, from: key });
      }
      for (const key of wanted) {
        const user = sameUser ? userId : key.replace("session-", "");
        peers.set(key, user);
        deliver({ event: "presence", payload: { userId: user }, from: key });
      }
    },
    /** A message another tab posted to the room, as the reader's stream carries it (the server checked its userId). */
    receive: (event: string, payload: Record<string, unknown>, from: string) => deliver({ event, payload, from }),
    unmount: () => {
      for (const cleanup of cleanups.splice(0).reverse()) cleanup?.();
    }
  };
}
