/**
 * The InsightsDesk port in memory: the Insights use cases themselves, run as the signed-in educator
 * over an in-memory read port, as the reader's server runs them over the Postgres views. With no
 * actor every ask is refused as `signed-out`.
 */
import type { CourseInsights, StudentProgress } from "@tutors/domain/insights";
import { educatorInsights } from "../insights/insights.ts";
import type { InsightsAnswer, InsightsDesk, InsightsSpan } from "../ports/insights-desk.ts";
import { InMemoryInsightsRead } from "./learning-contexts.ts";

export type InMemoryInsightsDeskOptions = {
  read?: InMemoryInsightsRead;
  /** Each course's educator logins. */
  educators?: Record<string, string[]>;
  /** The login signed in, or null for nobody. */
  actor?: string | null;
};

export class InMemoryInsightsDesk implements InsightsDesk {
  readonly read: InMemoryInsightsRead;
  readonly educators: Record<string, string[]>;
  readonly actor: string | null;

  constructor(options: InMemoryInsightsDeskOptions = {}) {
    this.read = options.read ?? new InMemoryInsightsRead();
    this.educators = options.educators ?? {};
    this.actor = options.actor ?? null;
  }

  /** A desk over the same rows, signed in as someone else (or nobody). */
  as(actor: string | null): InMemoryInsightsDesk {
    return new InMemoryInsightsDesk({ read: this.read, educators: this.educators, actor });
  }

  private insights() {
    return educatorInsights({ insights: this.read, educatorsOf: async (courseId) => this.educators[courseId] ?? [] });
  }

  async course(courseId: string, span: InsightsSpan, day: string): Promise<InsightsAnswer<CourseInsights>> {
    if (!this.actor) return { ok: false, reason: "signed-out" };
    return this.insights().course(this.actor, courseId, span, day);
  }

  async student(courseId: string, learnerId: string, span: InsightsSpan, day: string): Promise<InsightsAnswer<StudentProgress>> {
    if (!this.actor) return { ok: false, reason: "signed-out" };
    return this.insights().student(this.actor, courseId, learnerId, span, day);
  }
}

/** An insights desk for a deployment where nobody can sign in: every ask is refused. */
export class SignedOutInsightsDesk implements InsightsDesk {
  async course(): Promise<InsightsAnswer<CourseInsights>> {
    return { ok: false, reason: "signed-out" };
  }
  async student(): Promise<InsightsAnswer<StudentProgress>> {
    return { ok: false, reason: "signed-out" };
  }
}
