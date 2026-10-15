/**
 * Help requests, wherever an adapter keeps them. Writes are compare-and-set on the state so a
 * request moves to each state once even when two lecturers press at the same moment (Rule 0389).
 */
import type { HelpRequest, HelpState, NewHelpRequest } from "@tutors/domain/assistance";

export interface AssistanceStore {
  /**
   * Keeps a new request and resolves it with its id; rejects when it could not be kept. A durable
   * adapter rejects a second live request for the same learner and course (a unique index), so
   * two opens racing each other cannot both succeed.
   */
  open(request: NewHelpRequest): Promise<HelpRequest>;
  /** One request by id, or null. */
  get(id: string): Promise<HelpRequest | null>;
  /** The course's open and acknowledged requests, in no particular order. */
  live(courseId: string): Promise<HelpRequest[]>;
  /**
   * Replaces a request with `next` only while its stored state is still `from`; resolves false,
   * writing nothing, when the request is missing or has moved since.
   */
  replace(next: HelpRequest, from: HelpState): Promise<boolean>;
}
