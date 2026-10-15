/**
 * The reader's LiveEventReporter over HTTP: a queue, batched `fetch` posts to the live app's
 * `/api/live/events`, a `sendBeacon` flush on page hide, and the rotating session token in
 * `localStorage`. With no endpoint configured the reporter is a no-op throughout.
 */
export { browserStorage, httpLiveEventReporter, type HttpReporterOptions } from "./reporter.ts";
