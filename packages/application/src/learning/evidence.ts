import type { Evidence } from "@tutors/domain/learning";
import type { EventPublisher } from "../ports/event-publisher.ts";

/**
 * A learner recorded evidence at a step (shared a snippet, shared a reflection): tell the rest of
 * the application which step and what kind (Rule 0377). Nothing is published for a visitor who is
 * not signed in.
 */
export function recordEvidence({ publish }: { publish: EventPublisher["publish"] }) {
  return async (learnerId: string, evidence: Evidence): Promise<void> => {
    if (!learnerId) return;
    await publish({ type: "evidence-recorded", learnerId, evidence: { kind: evidence.kind, ref: evidence.ref, id: evidence.id, at: evidence.at } });
  };
}
