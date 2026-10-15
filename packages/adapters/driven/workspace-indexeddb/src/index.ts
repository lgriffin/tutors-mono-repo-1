/**
 * `@tutors/workspace-indexeddb`: the WorkspaceStore adapter over the browser's own IndexedDB.
 * A workspace survives without an account. IndexedDB rather than localStorage because a workspace
 * is a set of files rather than a string, and because localStorage is synchronous on the thread
 * that is also running the editor. Storage is a convenience, never a precondition: a browser in
 * private mode, or with storage disabled, still gets a working playground that forgets between
 * visits.
 */
import type { Workspace } from "@tutors/domain/course/playground";
import type { WorkspaceStore } from "@tutors/application/ports";

const DB_NAME = "tutors-playground";
const DB_STORE = "workspaces";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transact<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const request = run(db.transaction(DB_STORE, mode).objectStore(DB_STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      })
  );
}

const key = (courseId: string, loId: string) => `${courseId}::${loId}`;

export function indexedDbWorkspaceStore(): WorkspaceStore {
  return {
    async load(courseId, loId) {
      try {
        return (await transact<Workspace | undefined>("readonly", (store) => store.get(key(courseId, loId)))) ?? null;
      } catch {
        return null;
      }
    },
    async save(workspace) {
      try {
        await transact("readwrite", (store) => store.put(workspace, key(workspace.courseId, workspace.loId)));
      } catch {
        /* storage is a convenience here, never a precondition */
      }
    },
    async remove(courseId, loId) {
      try {
        await transact("readwrite", (store) => store.delete(key(courseId, loId)));
      } catch {
        /* as above */
      }
    }
  };
}
