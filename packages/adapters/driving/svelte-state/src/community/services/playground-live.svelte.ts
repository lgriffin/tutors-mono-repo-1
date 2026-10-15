/**
 * Live attach: a lecturer watching a playground as it is typed, over the PlaygroundLive port.
 *
 * Nothing is stored, and a student who is not sharing sends nothing at all: the lecturer's request
 * to watch is an announcement, not a pull. Consent lives on the student's side of the wire, the
 * only side that has the code. Snapshots are the durable half of the same feature
 * (`adapters().playgroundSnapshots`).
 */
import type { PlaygroundLiveState, PlaygroundShare } from "@tutors/application/ports";
import { adapters } from "../../adapters.ts";
import { rune } from "../../index.svelte.ts";

export type { PlaygroundLiveState };

/** A keystroke does not deserve a network round trip, and a lecturer reading along is not watching for frames. */
export const LIVE_SHARE_THROTTLE_MS = 1500;

export interface PlaygroundLiveService {
  /** How many lecturers have said they are watching this exercise, for the student's indicator. */
  watchers: { value: number };
  /** The students currently sharing, keyed by student id, for the lecturer's view. */
  shared: { value: Map<string, PlaygroundLiveState> };
  /** Start sharing this playground; returns the function to call with the current state. */
  startSharing(courseId: string, loId: string): (state: PlaygroundLiveState) => void;
  stopSharing(): void;
  startWatching(courseId: string, loId: string): void;
  stopWatching(): void;
}

let share: PlaygroundShare | null = null;
let stopWatch: (() => void) | null = null;
let lastSent = 0;
let pendingSend: ReturnType<typeof setTimeout> | undefined;

export const playgroundLiveService: PlaygroundLiveService = {
  watchers: rune<number>(0),
  shared: rune<Map<string, PlaygroundLiveState>>(new Map()),

  startSharing(courseId, loId) {
    this.stopSharing();
    const current = adapters().playgroundLive.share(courseId, loId, () => {
      this.watchers.value = this.watchers.value + 1;
    });
    share = current;
    return (state) => {
      const send = () => {
        lastSent = Date.now();
        current.send(state);
      };
      clearTimeout(pendingSend);
      const since = Date.now() - lastSent;
      if (since > LIVE_SHARE_THROTTLE_MS) send();
      else pendingSend = setTimeout(send, LIVE_SHARE_THROTTLE_MS - since);
    };
  },

  stopSharing() {
    clearTimeout(pendingSend);
    pendingSend = undefined;
    this.watchers.value = 0;
    share?.stop();
    share = null;
  },

  startWatching(courseId, loId) {
    this.stopWatching();
    this.shared.value = new Map();
    stopWatch = adapters().playgroundLive.watch(courseId, loId, (state) => {
      const updated = new Map(this.shared.value);
      updated.set(state.studentId, state);
      this.shared.value = updated;
    });
  },

  stopWatching() {
    stopWatch?.();
    stopWatch = null;
    this.shared.value = new Map();
  }
};
