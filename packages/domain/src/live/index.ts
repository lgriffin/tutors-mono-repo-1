/**
 * Tutors Live: the activity pipeline's vocabulary and arithmetic. The event contract and its
 * validation, the service catalogue, the rotating session token, the presence window, and the
 * pure functions that turn rollup rows into headline stats, heat maps, activity tables and
 * observation cards. Nothing here knows a bus, a database or a browser; those are ports.
 */
export * from "./catalogue.ts";
export * from "./events.ts";
export * from "./validate.ts";
export * from "./session.ts";
export * from "./rows.ts";
export * from "./presence-window.ts";
export * from "./metrics.ts";
export * from "./heatmap.ts";
export * from "./observations.ts";
export * from "./activity.ts";
