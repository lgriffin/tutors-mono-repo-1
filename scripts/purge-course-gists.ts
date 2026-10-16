/**
 * Purge expired course snippets (issue #155 — 48h ephemeral snippet sharing).
 *
 * Snippets live entirely in the Postgres store (`course_gists`), so expiry is a row delete and
 * nothing else (`purgeExpiredSnippets`, one DELETE per batch). There is no GitHub call, no stored
 * access token, and therefore no "orphaned on GitHub" failure mode — an earlier revision of this
 * feature stored snippets as gists and had to best-effort delete them with the student's OAuth token.
 *
 * Reads are already filtered on `expires_at > now()`, so an expired snippet is
 * invisible well before this job removes it. This job reclaims the storage.
 *
 * Env:
 *   PRIVATE_DATABASE_URL               (required: the Postgres store)
 *   (optional) BATCH_SIZE              (default 200)
 *   (optional) MAX_ITERATIONS          (default 50, safety cap)
 *   (optional) DRY_RUN=1               (read-only; no DELETEs)
 *
 * Run locally:
 *   DRY_RUN=1 pnpm tsx scripts/purge-course-gists.ts
 */

import process from "node:process";
import { postgresClient, purgeExpiredSnippets } from "@tutors/store-postgres";

/** Script output: the no-console rule (issue #211) keeps console.* to the logger package. */
const out = (...parts: unknown[]) => process.stdout.write(`${parts.join(" ")}\n`);
const err = (...parts: unknown[]) => process.stderr.write(`${parts.join(" ")}\n`);

const DATABASE_URL = process.env.PRIVATE_DATABASE_URL ?? "";
if (!DATABASE_URL) {
  err("FATAL: PRIVATE_DATABASE_URL is required (see .env.example)");
  process.exit(2);
}

const BATCH_SIZE = Math.max(1, Number(process.env.BATCH_SIZE ?? 200));
const MAX_ITERATIONS = Math.max(1, Number(process.env.MAX_ITERATIONS ?? 50));
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";

interface Summary {
  processed: number;
  deleted: number;
  failed: number;
}

/** The Postgres store: one DELETE per batch, so nothing is read back but the ids deleted. */
async function purge(): Promise<Summary> {
  const sql = postgresClient(DATABASE_URL);
  try {
    const count = await purgeExpiredSnippets(sql, new Date().toISOString(), { batchSize: BATCH_SIZE, maxBatches: MAX_ITERATIONS, dryRun: DRY_RUN });
    if (DRY_RUN) out(`[dry-run] would delete ${count} expired snippet(s)`);
    return { processed: count, deleted: DRY_RUN ? 0 : count, failed: 0 };
  } finally {
    await sql.end();
  }
}

function logSummary(s: Summary): void {
  out(`purge-course-gists (mode=${DRY_RUN ? "dry-run" : "live"})`);
  out(`  processed: ${s.processed}`);
  out(`  deleted:   ${s.deleted}`);
  out(`  failed:    ${s.failed}`);
}

async function main(): Promise<void> {
  const started = Date.now();
  const summary = await purge();
  logSummary(summary);
  out(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (summary.failed > 0) {
    throw new Error("Some rows could not be purged; see logs above");
  }
}

main().catch((e) => {
  err(e instanceof Error ? e.stack : e);
  process.exit(1);
});
