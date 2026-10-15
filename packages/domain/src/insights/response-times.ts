/** Time to acknowledge and time to resolve, per kind of help: median and 90th percentile seconds. */
import { HELP_KINDS, type HelpKind, type HelpRequest } from "../assistance/help-request.ts";
import { median, percentile } from "./statistics.ts";

export type ResponseTime = { median: number | null; p90: number | null; count: number };
export type ResponseTimes = Record<HelpKind, { acknowledge: ResponseTime; resolve: ResponseTime }>;

const seconds = (from: string, to: string | undefined) => (to ? Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000)) : null);
const summary = (values: number[]): ResponseTime => ({ median: median(values), p90: percentile(values, 90), count: values.length });

export function responseTimes(requests: readonly HelpRequest[]): ResponseTimes {
  const out = {} as ResponseTimes;
  for (const kind of HELP_KINDS) {
    const ofKind = requests.filter((r) => r.kind === kind);
    const ack = ofKind.map((r) => seconds(r.requestedAt, r.acknowledged?.at)).filter((s): s is number => s !== null);
    const res = ofKind
      .filter((r) => r.closed?.reason === "resolved" || r.closed?.reason === "hint")
      .map((r) => seconds(r.requestedAt, r.closed?.at))
      .filter((s): s is number => s !== null);
    out[kind] = { acknowledge: summary(ack), resolve: summary(res) };
  }
  return out;
}
