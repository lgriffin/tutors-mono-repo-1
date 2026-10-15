// @vitest-environment happy-dom
/**
 * The reader's RBAC service: a learner's role from the course's enrolment, what that role may do,
 * and a lecturer locking content through the composed AccessStore (with a copy kept in the
 * browser for a course whose store has none). The reader's global state is stood in for by plain
 * runes, as in lock-tree.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../packages/adapters/driving/svelte-state/src/index.svelte.ts", () => {
  const rune = <T>(initial: T) => ({ value: initial });
  return {
    rune,
    contentLocks: rune(new Map<string, boolean>()),
    isEducator: rune(false),
    locksLoaded: rune(false),
    tutorsId: rune(null),
    currentCourse: rune(null)
  };
});

import { FixedClock, InMemoryAccessStore } from "../../../packages/application/src/testing/index.ts";
import { anonymousAdapters, configureAdapters } from "../../../packages/adapters/driving/svelte-state/src/adapters.ts";
import { contentLocks, currentCourse, isEducator, tutorsId } from "../../../packages/adapters/driving/svelte-state/src/index.svelte.ts";
import { rbacService, SHOW_LOCKED_KEY } from "../../../packages/adapters/driving/svelte-state/src/rbac/rbac-service.svelte.ts";

const enrolment = { enrollment: { educators: ["eve"] } };
let store: InMemoryAccessStore;

/** Let the fire-and-forget store write land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  rbacService.clear();
  localStorage.clear();
  tutorsId.value = null;
  currentCourse.value = null;
  store = new InMemoryAccessStore(new FixedClock());
  configureAdapters(anonymousAdapters({ accessStore: store }));
});

describe("roles", () => {
  it("makes an educator named in the enrolment an educator, with a lecturer's permissions", () => {
    rbacService.loadRole("eve", "cs101", enrolment);
    expect(rbacService.role).toBe("educator");
    expect(rbacService.isEducator).toBe(true);
    expect(rbacService.hasPermission("content:lock")).toBe(true);
  });

  it("makes anyone else a student, who may not lock content", () => {
    rbacService.loadRole("ann", "cs101", enrolment);
    expect(rbacService.role).toBe("student");
    expect(rbacService.isEducator).toBe(false);
    expect(rbacService.hasPermission("content:lock")).toBe(false);
  });

  it("falls back to the current course's enrolment, and to student with no learner or course", () => {
    currentCourse.value = enrolment as never;
    rbacService.loadRole("eve", "cs101");
    expect(rbacService.role).toBe("educator");
    rbacService.loadRole("", "cs101");
    expect(rbacService.role).toBe("student");
    rbacService.loadRole("eve", "");
    expect(rbacService.currentRole.value).toBe("student");
  });
});

describe("checkLecturerStatus", () => {
  it("is a lecturer only when signed in and named among the educators", () => {
    tutorsId.value = { login: "eve" } as never;
    rbacService.checkLecturerStatus(enrolment);
    expect(isEducator.value).toBe(true);

    rbacService.checkLecturerStatus({ enrollment: { educators: ["bob"] } });
    expect(isEducator.value).toBe(false);

    currentCourse.value = enrolment as never;
    rbacService.checkLecturerStatus();
    expect(isEducator.value).toBe(true);

    currentCourse.value = null;
    rbacService.checkLecturerStatus();
    expect(isEducator.value).toBe(false);

    tutorsId.value = null;
    rbacService.checkLecturerStatus(enrolment);
    expect(isEducator.value).toBe(false);
  });
});

describe("toggleContentLock", () => {
  it("locks a route at once, keeps a copy in the browser, and writes it to the store as the lecturer", async () => {
    rbacService.loadRole("eve", "cs101", enrolment);
    expect(await rbacService.toggleContentLock("/lab/cs101/lab-1", true)).toBe(true);
    expect(rbacService.isLocked("/lab/cs101/lab-1")).toBe(true);
    expect(rbacService.isLocked("/lab/cs101/lab-2")).toBe(false);
    expect(JSON.parse(localStorage.getItem("tutors-locks-cs101")!)).toEqual({ "/lab/cs101/lab-1": true });
    await settle();
    expect(await store.locks("cs101")).toMatchObject([{ lo_route: "/lab/cs101/lab-1", locked: true, locked_by: "eve" }]);
  });

  it("takes the course and lecturer from the reader when no role was loaded", async () => {
    currentCourse.value = { courseId: "cs102" } as never;
    tutorsId.value = { login: "eve" } as never;
    expect(await rbacService.setShowLockedToStudents(true)).toBe(true);
    expect(rbacService.showLockedToStudents()).toBe(true);
    await settle();
    expect(await store.locks("cs102")).toMatchObject([{ lo_route: SHOW_LOCKED_KEY, locked: true, locked_by: "eve" }]);
  });

  it("writes as dev-user with nobody signed in", async () => {
    currentCourse.value = { courseId: "cs103" } as never;
    await rbacService.toggleContentLock("/lab/cs103/lab-1", true);
    await settle();
    expect((await store.locks("cs103"))[0].locked_by).toBe("dev-user");
  });

  it("refuses with no course to lock in", async () => {
    expect(await rbacService.toggleContentLock("/lab/x", true)).toBe(false);
    expect(contentLocks.value.size).toBe(0);
  });
});

describe("loadContentLocks", () => {
  it("restores the browser's copy for a course whose store has no locks", async () => {
    localStorage.setItem("tutors-locks-cs101", JSON.stringify({ "/lab/cs101/lab-1": true, "/lab/cs101/lab-2": false }));
    await rbacService.loadContentLocks("cs101");
    expect(rbacService.isLocked("/lab/cs101/lab-1")).toBe(true);
    expect(rbacService.isLocked("/lab/cs101/lab-2")).toBe(false);
  });

  it("ignores a browser copy it cannot read", async () => {
    localStorage.setItem("tutors-locks-cs101", "{not json");
    await rbacService.loadContentLocks("cs101");
    expect(contentLocks.value.size).toBe(0);
  });
});
