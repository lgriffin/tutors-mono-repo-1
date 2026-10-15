/**
 * Browser code reads and writes no table and calls no database function: every one goes through the
 * data API (@tutors/data-api, guides/SERVER-WRITES.md), so the store behind it can change without a
 * browser path noticing (Rule 0471). There is no allowlist: a `.from("table")` or `.rpc("fn")` in
 * browser code is a finding. Realtime channels are not table access and are not checked; the
 * browser's Supabase client exists only for them, until realtime moves to the reader's servers.
 *
 * Lexical, like the other checks: it finds `.from("table")` and `.rpc("fn")` calls in browser code
 * (the driving adapters, the driven adapters the browser composes, and apps/<app>/src, except
 * server-only files and the driven adapters' server modules).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { REPO_ROOT } from "./lib/repo.ts";

/** Server-only files: SvelteKit never bundles them for the browser. */
const SERVER_ONLY = /\.server\.ts$|(^|\/)(lib\/server\/|hooks\.server\.ts$|\+server\.ts$|\+page\.server\.ts$|\+layout\.server\.ts$)/;

/**
 * Modules of the driven adapters that only the servers compose, with the service-role client: the
 * whole store adapter except the client factory the browser builds its Realtime client with, and the
 * realtime adapter's server side (the Live budget claim and watcher report). The browser composes
 * these packages too, but only for `createSupabaseClient` and the Realtime channels.
 */
const STORE_SRC = "packages/adapters/driven/store-supabase/src/";
const SERVER_MODULES = new Set(["packages/adapters/driven/realtime-supabase/src/live-activity.ts"]);

function isServerModule(file: string): boolean {
  return (file.startsWith(STORE_SRC) && file !== `${STORE_SRC}client.ts`) || SERVER_MODULES.has(file);
}

/** The packages the browser may be bundled with: every driving adapter and the driven adapters the apps compose in the browser. */
const BROWSER_PACKAGE_ROOTS = ["packages/adapters/driving", "packages/adapters/driven"];

export interface DataAccessFinding {
  file: string;
  line: number;
  message: string;
}

/** Findings in one browser file's source. */
export function scanBrowserSource(file: string, source: string): DataAccessFinding[] {
  const findings: DataAccessFinding[] = [];
  const lineOf = (index: number) => source.slice(0, index).split("\n").length;
  for (const m of source.matchAll(/\.from\(\s*["'`]([^"'`]+)["'`]\s*\)\s*\.\s*(\w+)\s*\(/g)) {
    const [, table, method] = m;
    findings.push({ file, line: lineOf(m.index), message: `calls .${method}() on "${table}" from the browser; it goes through a data API route (@tutors/data-api)` });
  }
  for (const m of source.matchAll(/\.rpc\(\s*["'`]([^"'`]+)["'`]/g)) {
    findings.push({ file, line: lineOf(m.index), message: `calls the database function "${m[1]}" from the browser; it goes through a data API route (@tutors/data-api)` });
  }
  return findings;
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".svelte-kit" || entry === "build" || entry === "dist") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|svelte)$/.test(entry) && !/\.(test|spec)\.ts$/.test(entry)) out.push(path);
  }
}

/** Every finding in the repository's browser code. */
export function scanBrowserCode(root: string = REPO_ROOT): DataAccessFinding[] {
  const files: string[] = [];
  for (const packages of BROWSER_PACKAGE_ROOTS) walk(join(root, packages), files);
  for (const app of readdirSync(join(root, "apps"))) walk(join(root, "apps", app, "src"), files);
  return files
    .map((path) => relative(root, path))
    .filter((file) => !SERVER_ONLY.test(file) && !isServerModule(file))
    .flatMap((file) => scanBrowserSource(file, readFileSync(join(root, file), "utf8")));
}
