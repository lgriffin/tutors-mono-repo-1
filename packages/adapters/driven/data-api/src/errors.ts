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
/** The route refuses a report over 16 KB; a report is packed to stay under this, with room for the envelope. */
export const MAX_REPORT_BYTES = 15 * 1024;
/** A context larger than this (a stack, a response body) is replaced by a note that it was dropped. */
const MAX_CONTEXT_BYTES = 2 * 1024;

const bytes = (text: string) => new TextEncoder().encode(text).length;

/** The context as given, or a note when it is too large to report or cannot be serialised. */
function boundedContext(rest: Record<string, unknown>): Record<string, unknown> {
  if (Object.keys(rest).length === 0) return {};
  try {
    const size = bytes(JSON.stringify(rest));
    return size <= MAX_CONTEXT_BYTES ? rest : { contextDropped: `${size} bytes` };
  } catch {
    return { contextDropped: "not serialisable" };
  }
}

function entryOf(entry: LogEntry): ErrorReportEntry {
  const { timestamp: _timestamp, level, message, app: _app, studentId: _studentId, ...rest } = entry;
  return {
    level: level === "warn" ? "warn" : "error",
    // One line: the route refuses control characters, and a multi-line message would cost the whole batch.
    message: String(message)
      .replace(/\p{Cc}+/gu, " ")
      .slice(0, MAX_MESSAGE),
    context: boundedContext(rest),
    url: typeof window !== "undefined" ? window.location.href : null,
    courseId: typeof entry.courseId === "string" ? entry.courseId : null
  };
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
    // As many entries as fit in one report the route accepts; the rest wait for the next flush.
    const entries: ErrorReportEntry[] = [];
    let size = bytes(JSON.stringify({ app: appName, entries: [] }));
    for (const entry of buffer) {
      const entrySize = bytes(JSON.stringify(entry)) + 1;
      if (entries.length === MAX_ERROR_BATCH || (entries.length > 0 && size + entrySize > MAX_REPORT_BYTES)) break;
      entries.push(entry);
      size += entrySize;
    }
    buffer = buffer.slice(entries.length);
    if (buffer.length > 0) timer = setTimeout(flush, FLUSH_INTERVAL_MS);
    return { app: appName, entries };
  };

  function flush() {
    const report = take();
    if (report) void api.reportErrors(report).catch(() => undefined);
  }

  const flushOnUnload = () => {
    const report = take();
    if (!report) return;
    // Every context was serialised once already (boundedContext), so this cannot throw.
    const body = JSON.stringify(report);
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
    // The buffer stays bounded: twenty entries waiting send a report at once, and what does not fit
    // under the size limit waits for the next.
    buffer.push(entryOf(entry));
    if (buffer.length >= MAX_ERROR_BATCH) flush();
    else timer ??= setTimeout(flush, FLUSH_INTERVAL_MS);
  };
}
