import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { REPO_ROOT } from "../../../../scripts/checks/lib/repo.ts";

const feature = await loadFeature("tests/bdd/features/developer/no-supabase.feature");

/** The repository's tracked files, so nothing installed or built is read. */
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
const read = (file: string) => readFileSync(join(REPO_ROOT, file), "utf8");
const names = (list: string) => list.split(",").map((name) => name.trim());

/** Files that name one of `settings` as a whole word. */
function naming(files: string[], settings: string[]): string[] {
  return files.filter((file) => settings.some((setting) => new RegExp(`\\b${setting}\\b`).test(read(file))));
}

describeFeature(feature, ({ Rule }) => {
  let files: string[] = [];

  Rule("Tutors shall depend on no Supabase client and read no Supabase setting, in any app, package, script or deployment file.", ({ RuleScenario }) => {
    RuleScenario("No workspace package depends on a Supabase client", ({ Given, Then, And }) => {
      Given("the package manifests of the workspace", () => {
        files = tracked.filter((file) => file === "package.json" || file.endsWith("/package.json"));
        expect(files.length).toBeGreaterThan(10);
      });
      Then("no manifest names a dependency in the {string} scope", (_ctx, scope: string) => {
        const offenders = files.filter((file) => {
          const manifest = JSON.parse(read(file)) as Record<string, Record<string, string> | undefined>;
          return ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].some((field) =>
            Object.keys(manifest[field] ?? {}).some((name) => name.startsWith(`${scope}/`))
          );
        });
        expect(offenders).toEqual([]);
      });
      And("the lockfile holds no package in the {string} scope", (_ctx, scope: string) => {
        expect(read("pnpm-lock.yaml").includes(`${scope}/`)).toBe(false);
      });
    });

    RuleScenario("No source file imports a Supabase client or reads a Supabase setting", ({ Given, Then, And }) => {
      Given("the TypeScript, JavaScript and Svelte sources of the apps, packages and scripts", () => {
        files = tracked.filter((file) => /^(apps|packages|scripts|services)\//.test(file) && /\.(ts|js|mjs|cjs|svelte|html)$/.test(file) && !/\.min\.m?js$/.test(file));
        expect(files.length).toBeGreaterThan(100);
      });
      Then("no source imports a module in the {string} scope", (_ctx, scope: string) => {
        const importing = new RegExp(`(from\\s+|import\\(\\s*|require\\(\\s*|esm\\.sh/)["'\`]?${scope}/`);
        expect(files.filter((file) => importing.test(read(file)))).toEqual([]);
      });
      And("no source reads {string}", (_ctx, settings: string) => {
        expect(naming(files, names(settings))).toEqual([]);
      });
    });

    RuleScenario("No deployment file sets a Supabase setting", ({ Given, Then, And }) => {
      Given("the environment example, the compose files and the Kubernetes manifests", () => {
        files = tracked.filter((file) => /(^|\/)\.env\.example$/.test(file) || /(^|\/)(compose|docker-compose)\.ya?ml$/.test(file) || /^deploy\/.*\.ya?ml(\.example)?$/.test(file));
        expect(files).toContain(".env.example");
        expect(files).toContain("deploy/k8s/base/configmap.yaml");
      });
      Then("none sets {string}", (_ctx, settings: string) => {
        expect(naming(files, names(settings))).toEqual([]);
      });
      And("the repository has no {string} directory", (_ctx, directory: string) => {
        expect(existsSync(join(REPO_ROOT, directory))).toBe(false);
        expect(tracked.filter((file) => file.startsWith(`${directory}/`))).toEqual([]);
      });
    });
  });
});
