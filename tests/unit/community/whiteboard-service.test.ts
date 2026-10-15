/**
 * The whiteboard service: which room a learner draws in and whether their edits are saved. A
 * personal room belongs to the signed-in learner; a visitor or the anonymous reader saves nothing.
 */
import "../../bdd/support/svelte-runes-shim.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryWhiteboardStore } from "../../../packages/application/src/testing/index.ts";
import type { WhiteboardStore } from "../../../packages/application/src/ports/index.ts";
import type { TutorsId } from "../../../packages/domain/src/course/index.ts";
import { anonymousAdapters, configureAdapters } from "../../../packages/adapters/driving/svelte-state/src/adapters.ts";
import { tutorsId } from "../../../packages/adapters/driving/svelte-state/src/index.svelte.ts";
import { whiteboardService } from "../../../packages/adapters/driving/svelte-state/src/community/services/whiteboard.svelte.ts";

const ROUTE = ["cs101", "/lab/cs101/whiteboard"] as const;
let store: InMemoryWhiteboardStore;

function signIn(login: string | null) {
  tutorsId.value = login === null ? null : ({ login, name: login } as TutorsId);
}

function compose(overrides: { anonymous?: boolean; whiteboard?: WhiteboardStore } = {}) {
  configureAdapters({ ...anonymousAdapters({ whiteboard: overrides.whiteboard ?? store }), anonymous: overrides.anonymous ?? false });
}

beforeEach(() => {
  store = new InMemoryWhiteboardStore();
  whiteboardService.reset();
  signIn(null);
  compose();
});

afterEach(() => {
  signIn(null);
  configureAdapters(anonymousAdapters());
});

describe("whiteboardService: a signed-in learner", () => {
  beforeEach(() => signIn("ann"));

  it("saves to and loads from their own room", async () => {
    expect(whiteboardService.canSave()).toBe(true);
    expect(whiteboardService.idleStatus()).toBe("Use the whiteboard export menu to keep a copy of your work.");
    expect(await whiteboardService.saveScene(...ROUTE, [{ id: "rect" }])).toBe(true);
    expect(whiteboardService.saveStatus.value).toBe("Drawing changes saved");
    expect(await whiteboardService.loadScene(...ROUTE)).toEqual({ elements: [{ id: "rect" }], appState: {}, files: {} });

    signIn("bob");
    expect(await whiteboardService.loadScene(...ROUTE)).toBeNull();
  });

  it("saves to the course's shared board once switched to it", async () => {
    whiteboardService.setShared(true);
    expect(whiteboardService.shared.value).toBe(true);
    await whiteboardService.saveScene(...ROUTE, [{ id: "shared" }]);
    signIn("bob");
    expect(await whiteboardService.loadScene(...ROUTE)).toMatchObject({ elements: [{ id: "shared" }] });
  });

  it("says a save failed, whether the store refused or threw", async () => {
    compose({ whiteboard: { load: async () => null, save: async () => false } });
    expect(await whiteboardService.saveScene(...ROUTE, [])).toBe(false);
    expect(whiteboardService.saveStatus.value).toBe("Changes could not be saved. Keep this whiteboard open and export your work.");

    compose({ whiteboard: { load: async () => Promise.reject(new Error("down")), save: async () => Promise.reject(new Error("down")) } });
    whiteboardService.reset();
    expect(await whiteboardService.saveScene(...ROUTE, [])).toBe(false);
    expect(whiteboardService.saveStatus.value).toBe("Changes could not be saved. Keep this whiteboard open and export your work.");
    expect(await whiteboardService.loadScene(...ROUTE)).toBeNull();
  });

  it("goes back to the learner's own room, with nothing said, on reset", () => {
    whiteboardService.setShared(true);
    whiteboardService.saveStatus.value = "Saving…";
    whiteboardService.reset();
    expect(whiteboardService.shared.value).toBe(false);
    expect(whiteboardService.saveStatus.value).toBe("");
  });
});

describe("whiteboardService: a visitor who is not signed in", () => {
  it("is asked to sign in to save, and has no personal scene", async () => {
    expect(whiteboardService.canSave()).toBe(false);
    expect(whiteboardService.idleStatus()).toBe("Sign in to save your edits. Use the export menu to keep a copy.");
    expect(await whiteboardService.saveScene(...ROUTE, [{ id: "x" }])).toBe(false);
    expect(whiteboardService.saveStatus.value).toBe("Sign in to save your edits. Use the export menu to keep a copy.");
    expect(await whiteboardService.loadScene(...ROUTE)).toBeNull();
    expect(store.scenes.size).toBe(0);
  });

  it("can still see the course's shared board", async () => {
    await store.save({ courseId: ROUTE[0], route: ROUTE[1], shared: true }, null, [{ id: "board" }]);
    whiteboardService.setShared(true);
    expect(await whiteboardService.loadScene(...ROUTE)).toMatchObject({ elements: [{ id: "board" }] });
  });
});

describe("whiteboardService: the anonymous reader", () => {
  it("neither loads nor saves, even for a signed-in identity", async () => {
    await store.save({ courseId: ROUTE[0], route: ROUTE[1], shared: true }, null, [{ id: "board" }]);
    compose({ anonymous: true });
    signIn("ann");
    whiteboardService.setShared(true);
    expect(whiteboardService.canSave()).toBe(false);
    expect(await whiteboardService.loadScene(...ROUTE)).toBeNull();
    expect(await whiteboardService.saveScene(...ROUTE, [])).toBe(false);
  });
});
