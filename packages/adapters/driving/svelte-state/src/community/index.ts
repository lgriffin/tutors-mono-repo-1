/**
 * Re-exports community services and types for easier imports
 * @module
 */

// Service exports
export { liveService } from "./services/live.svelte.ts";
export { presenceService } from "./services/presence.svelte.ts";
export { analyticsService } from "./services/analytics.svelte.ts";

// Lecturer broadcasts and snippet pings (issues #78 and #155)
export { noticeService } from "./services/notices.ts";
export { snippetService, type ShareOutcome } from "./services/snippets.ts";

// Type exports
export type { LoUser, LoEvent, TutorsConnectLatestRow } from "./types.svelte.ts";
export { LoRecord } from "./types.svelte.ts";

// Local-day rules, as the live app has always imported them from here; they live in the domain now.
export { isReceivedAtOnLocalDay, isReceivedAtInLocalWeek, isReceivedAtInLocalMonth, isReceivedAtInLocalYear } from "@tutors/domain/learning";
