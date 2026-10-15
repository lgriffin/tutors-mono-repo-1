import type { WorkspaceFile } from "@tutors/domain/course/playground";
import type { Unsubscribe } from "./presence.ts";

/** What a sharing student's playground looks like right now. */
export type PlaygroundLiveState = {
  studentId: string;
  studentName: string;
  files: WorkspaceFile[];
  activePath: string;
  output: string;
  running: boolean;
  updatedAt: string;
};

/** A student's live share: send the current state, or stop. */
export type PlaygroundShare = {
  send(state: PlaygroundLiveState): void;
  stop(): void;
};

/**
 * Live attach: a lecturer watching a playground as it is typed. Nothing is stored and a student
 * who is not sharing sends nothing at all; a lecturer's `watch` is an announcement the student's
 * side hears, not a pull. Consent lives on the student's side of the wire, the only side that
 * has the code.
 */
export interface PlaygroundLive {
  /** Start sharing one exercise; `onWatcher` fires each time a lecturer announces they are watching. */
  share(courseId: string, loId: string, onWatcher: () => void): PlaygroundShare;
  /** Watch one exercise; `onState` receives each sharing student's latest state. */
  watch(courseId: string, loId: string, onState: (state: PlaygroundLiveState) => void): Unsubscribe;
}
