/**
 * The browser's error transport: warnings and errors are batched and posted to the reader's
 * POST /api/errors, which writes them to the error log with its service key. No browser holds a
 * key that can insert into `app_errors` (Rule 0472).
 */
import type { LogEntry } from "@tutors/logger";
import type { ErrorReport, ErrorReportEntry } from "./contract.ts";
import { dataApi, type DataApi } from "./client.ts";

const FLUSH_INTERVAL_MS = 5000;
/** The most entries one report carries; the route refuses more. */
export const MAX_ERROR_BATCH = 20;
const MAX_MESSAGE = 1000;

function entryOf(entry: LogEntry): ErrorReportEntry {
  const { timestamp: _timestamp, level, message, app: _app, studentId: _studentId, ...rest } = entry;
  return {
    level: level === "warn" ? "warn" : "error",
    message: String(message).slice(0, MAX_MESSAGE),
    context: Object.keys(rest).length > 0 ? rest : {},
    url: typeof window !== "undefined" ? window.location.href : null,
    courseId: typeof entry.courseId === "string" ? entry.courseId : null
  };
}

/** The report's JSON, or null when it cannot be serialised (a context with a cycle). */
function serialise(report: ErrorReport): string | null {
  try {
    return JSON.stringify(report);
  } catch {
    return null;
  }
}

/**
 * A logger transport that reports `appName`'s warnings and errors through `api`. On page unload the
 * buffer goes out with `keepalive` (a beacon on the reader's own origin), so the last errors before
 * a crash are not lost. A failed report is dropped: the transport never throws.
 */
export function dataApiErrorTransport(appName: string, api: DataApi = dataApi): (entry: LogEntry) => void {
  let buffer: ErrorReportEntry[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const take = (): ErrorReport | null => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (buffer.length === 0) return null;
    const entries = buffer.slice(0, MAX_ERROR_BATCH);
    buffer = [];
    return { app: appName, entries };
  };

  const flush = () => {
    const report = take();
    if (report) void api.reportErrors(report).catch(() => undefined);
  };

  const flushOnUnload = () => {
    const report = take();
    const body = report && serialise(report);
    if (!body) return;
    const url = `${api.base}/api/errors`;
    // sendBeacon survives page unload where a plain fetch does not; it sends no preflight, so only to the reader's own origin.
    const nav = typeof navigator === "undefined" ? undefined : (navigator as Navigator & { sendBeacon?: (url: string, data: Blob) => boolean });
    if (!api.base && nav?.sendBeacon?.(url, new Blob([body], { type: "application/json" }))) return;
    try {
      void fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => undefined);
    } catch {
      // best effort on unload; nothing more can be done
    }
  };

  if (typeof window !== "undefined") window.addEventListener("beforeunload", flushOnUnload);

  return (entry) => {
    if (entry.level !== "warn" && entry.level !== "error") return;
    // A failed report is itself logged (client.ts); reporting that would post forever.
    if (entry.path === "/api/errors") return;
    buffer.push(entryOf(entry));
    if (buffer.length >= MAX_ERROR_BATCH) flush();
    else timer ??= setTimeout(flush, FLUSH_INTERVAL_MS);
  };
}
