/**
 * The WorkspaceStore over IndexedDB, against a small in-memory IndexedDB with the browser's
 * asynchronous request/callback shape. It runs the WorkspaceStore contract, then the property the
 * adapter exists for: storage is a convenience, so a browser without IndexedDB, or one that refuses
 * to open it or to answer a request, still gets a working playground that simply forgets.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { workspaceStoreContract } from "@tutors/application/testing";
import { indexedDbWorkspaceStore } from "@tutors/workspace-indexeddb";

type Request<T> = { result?: T; error?: unknown; onsuccess?: () => void; onerror?: () => void; onupgradeneeded?: () => void };
type Failing = "open" | "request" | null;

/** One origin's IndexedDB: databases of object stores of key/value pairs. */
function fakeIndexedDb(failing: Failing = null) {
  const databases = new Map<string, Map<string, Map<string, unknown>>>();
  const opened: { name: string; version: number; upgraded: boolean }[] = [];

  function answer<T>(request: Request<T>, run: () => T): Request<T> {
    setTimeout(() => {
      if (failing === "request") {
        request.error = new DOMException("QuotaExceededError");
        request.onerror?.();
        return;
      }
      request.result = run();
      request.onsuccess?.();
    }, 0);
    return request;
  }

  const factory = {
    open(name: string, version: number) {
      const request: Request<unknown> = {};
      setTimeout(() => {
        if (failing === "open") {
          request.error = new DOMException("blocked by private mode");
          request.onerror?.();
          return;
        }
        const fresh = !databases.has(name);
        const stores = databases.get(name) ?? new Map<string, Map<string, unknown>>();
        databases.set(name, stores);
        request.result = {
          objectStoreNames: { contains: (store: string) => stores.has(store) },
          createObjectStore: (store: string) => stores.set(store, new Map()),
          transaction: (store: string, mode: string) => ({
            objectStore: () => {
              const items = stores.get(store)!;
              return {
                get: (key: string) => answer({}, () => items.get(key)),
                put: (value: unknown, key: string) => {
                  expect(mode).toBe("readwrite");
                  return answer({}, () => (items.set(key, structuredClone(value)), key));
                },
                delete: (key: string) => answer({}, () => void items.delete(key))
              };
            }
          })
        };
        opened.push({ name, version, upgraded: fresh });
        if (fresh) request.onupgradeneeded?.();
        request.onsuccess?.();
      }, 0);
      return request;
    }
  };
  return { factory, databases, opened };
}

afterEach(() => vi.unstubAllGlobals());

describe("WorkspaceStore: IndexedDB", () => {
  for (const c of workspaceStoreContract(() => {
    vi.stubGlobal("indexedDB", fakeIndexedDb().factory);
    return indexedDbWorkspaceStore();
  }))
    it(c.name, c.run);
});

describe("indexedDbWorkspaceStore", () => {
  const workspace = { courseId: "cs101", loId: "/playground/cs101/hello", files: [{ path: "main.py", content: "print(1)" }], entry: "main.py", updatedAt: "2026-09-10T09:00:00.000Z" };

  it("keeps workspaces in one versioned database, creating its store only on first open", async () => {
    const idb = fakeIndexedDb();
    vi.stubGlobal("indexedDB", idb.factory);
    const store = indexedDbWorkspaceStore();

    await store.save(workspace);
    await store.load("cs101", "/playground/cs101/hello");

    expect(idb.opened).toEqual([
      { name: "tutors-playground", version: 1, upgraded: true },
      { name: "tutors-playground", version: 1, upgraded: false }
    ]);
    expect([...idb.databases.get("tutors-playground")!.get("workspaces")!.keys()]).toEqual(["cs101::/playground/cs101/hello"]);
  });

  it("forgets quietly in a browser with no IndexedDB", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const store = indexedDbWorkspaceStore();
    await store.save(workspace);
    await store.remove("cs101", "/playground/cs101/hello");
    expect(await store.load("cs101", "/playground/cs101/hello")).toBeNull();
  });

  it("forgets quietly when the database will not open", async () => {
    vi.stubGlobal("indexedDB", fakeIndexedDb("open").factory);
    const store = indexedDbWorkspaceStore();
    await store.save(workspace);
    await store.remove("cs101", "/playground/cs101/hello");
    expect(await store.load("cs101", "/playground/cs101/hello")).toBeNull();
  });

  it("forgets quietly when a read or write is refused", async () => {
    const idb = fakeIndexedDb("request");
    vi.stubGlobal("indexedDB", idb.factory);
    const store = indexedDbWorkspaceStore();
    await store.save(workspace);
    await store.remove("cs101", "/playground/cs101/hello");
    expect(await store.load("cs101", "/playground/cs101/hello")).toBeNull();
    expect(idb.databases.get("tutors-playground")!.get("workspaces")!.size).toBe(0);
  });
});
