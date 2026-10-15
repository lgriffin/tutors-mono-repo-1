/**
 * Live attach as the reader drives it: a student sharing a playground and a lecturer watching it,
 * over the in-memory PlaygroundLive (the same bus the contract suite pins). Sends are throttled, so
 * the clock is faked.
 */
import "../../bdd/support/svelte-runes-shim.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryPlaygroundLive } from "../../../packages/application/src/testing/index.ts";
import type { PlaygroundLiveState } from "../../../packages/application/src/ports/index.ts";
import { anonymousAdapters, configureAdapters } from "../../../packages/adapters/driving/svelte-state/src/adapters.ts";
import { LIVE_SHARE_THROTTLE_MS, playgroundLiveService } from "../../../packages/adapters/driving/svelte-state/src/community/services/playground-live.svelte.ts";

const EXERCISE = ["cs101", "/playground/cs101/topic/hello"] as const;
const state = (studentId: string, output = ""): PlaygroundLiveState => ({
  studentId,
  studentName: studentId,
  files: [{ path: "main.py", content: "print(1)" }],
  activePath: "main.py",
  output,
  running: false,
  updatedAt: "2026-09-10T09:00:00.000Z"
});

let live: InMemoryPlaygroundLive;
/** The service remembers its last send across tests, so each test starts an hour after the one before. */
let epoch = Date.parse("2030-01-01T00:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers();
  epoch += 60 * 60_000;
  vi.setSystemTime(epoch);
  live = new InMemoryPlaygroundLive();
  configureAdapters({ ...anonymousAdapters({ playgroundLive: live }), anonymous: false });
});

afterEach(() => {
  playgroundLiveService.stopSharing();
  playgroundLiveService.stopWatching();
  vi.useRealTimers();
});

describe("playgroundLiveService: the lecturer watching", () => {
  it("sees each sharing student's latest state, keyed by student", () => {
    playgroundLiveService.startWatching(...EXERCISE);
    const ada = live.share(...EXERCISE, () => {});
    const bob = live.share(...EXERCISE, () => {});
    ada.send(state("ada", "1"));
    bob.send(state("bob"));
    ada.send(state("ada", "2"));
    const shared = playgroundLiveService.shared.value;
    expect([...shared.keys()]).toEqual(["ada", "bob"]);
    expect(shared.get("ada")?.output).toBe("2");
  });

  it("forgets what it saw, and hears nothing more, once it stops", () => {
    playgroundLiveService.startWatching(...EXERCISE);
    const ada = live.share(...EXERCISE, () => {});
    ada.send(state("ada"));
    playgroundLiveService.stopWatching();
    expect(playgroundLiveService.shared.value.size).toBe(0);
    ada.send(state("ada"));
    expect(playgroundLiveService.shared.value.size).toBe(0);
  });

  it("starts afresh when it moves to another exercise", () => {
    playgroundLiveService.startWatching(...EXERCISE);
    live.share(...EXERCISE, () => {}).send(state("ada"));
    playgroundLiveService.startWatching("cs101", "/playground/cs101/topic/other");
    expect(playgroundLiveService.shared.value.size).toBe(0);
    live.share(...EXERCISE, () => {}).send(state("bob"));
    expect(playgroundLiveService.shared.value.size).toBe(0);
  });
});

describe("playgroundLiveService: the student sharing", () => {
  it("counts each lecturer who starts watching, and resets the count on stop", () => {
    playgroundLiveService.startSharing(...EXERCISE);
    expect(playgroundLiveService.watchers.value).toBe(0);
    live.watch(...EXERCISE, () => {});
    live.watch(...EXERCISE, () => {});
    expect(playgroundLiveService.watchers.value).toBe(2);
    playgroundLiveService.stopSharing();
    expect(playgroundLiveService.watchers.value).toBe(0);
  });

  it("sends the first state at once and holds later keystrokes to one send per throttle window, latest wins", () => {
    const send = playgroundLiveService.startSharing(...EXERCISE);
    send(state("ada", "a"));
    expect(live.sent.map((s) => s.output)).toEqual(["a"]);

    vi.advanceTimersByTime(100);
    send(state("ada", "b"));
    send(state("ada", "c"));
    expect(live.sent.map((s) => s.output)).toEqual(["a"]);

    vi.advanceTimersByTime(LIVE_SHARE_THROTTLE_MS - 100);
    expect(live.sent.map((s) => s.output)).toEqual(["a", "c"]);

    vi.advanceTimersByTime(LIVE_SHARE_THROTTLE_MS + 1);
    send(state("ada", "d"));
    expect(live.sent.map((s) => s.output)).toEqual(["a", "c", "d"]);
  });

  it("drops a held state when sharing stops, and sends nothing after", () => {
    const send = playgroundLiveService.startSharing(...EXERCISE);
    send(state("ada", "a"));
    send(state("ada", "held"));
    playgroundLiveService.stopSharing();
    vi.advanceTimersByTime(LIVE_SHARE_THROTTLE_MS * 2);
    send(state("ada", "late"));
    expect(live.sent.map((s) => s.output)).toEqual(["a"]);
  });

  it("stops the previous share when sharing another exercise", () => {
    const first = playgroundLiveService.startSharing(...EXERCISE);
    playgroundLiveService.startSharing("cs101", "/playground/cs101/topic/other");
    vi.advanceTimersByTime(LIVE_SHARE_THROTTLE_MS + 1);
    first(state("ada", "old"));
    expect(live.sent).toEqual([]);
  });
});
