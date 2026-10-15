/**
 * Help requests, wherever an adapter keeps them. Writes are compare-and-set on the request as it was
 * read (its state, kind and step) so a request moves to each state once even when two lecturers
 * press at the same moment (Rule 0389), and a lecturer acting on a stale read never undoes the
 * student asking again on another step or kind.
 */
import type { HelpRequest, NewHelpRequest } from "@tutors/domain/assistance";

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
  /** The learner's most recently raised request in the course, in any state, or null. */
  latest(courseId: string, learnerId: string): Promise<HelpRequest | null>;
  /**
   * Replaces every field of a request with `next` only while the stored request still has `prior`'s
   * state, kind, step and rating; resolves false, writing nothing, when it is missing or has changed
   * since.
   */
  replace(next: HelpRequest, prior: HelpRequest): Promise<boolean>;
}
