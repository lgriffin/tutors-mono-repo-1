<script lang="ts">
  import type { SharedSnippet } from "@tutors/application/ports";
  import { t } from "@tutors/i18n";
  import StudentAvatar from "#lib/components/StudentAvatar.svelte";

  interface Props {
    /** Rows supplied by the authorised server load, never fetched client-side. */
    rows: SharedSnippet[];
    error?: string | null;
  }

  let { rows, error = null }: Props = $props();

  /** The row whose body is expanded, by id. Snippets are shown inline, not linked out. */
  let expanded = $state<string | null>(null);

  function toggle(id: string) {
    expanded = expanded === id ? null : id;
  }

  function formatDateTime(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString("en-US", { day: "numeric", month: "short" }) + ", " + d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  }

  /** Human time remaining until expiry, e.g. "3h 12m". */
  function timeLeft(expiresAt: string): string {
    const ms = new Date(expiresAt).getTime() - Date.now();
    if (Number.isNaN(ms)) return expiresAt;
    if (ms <= 0) return t("classTime.snippetExpired");
    const mins = Math.floor(ms / 60000);
    const days = Math.floor(mins / 1440);
    const hours = Math.floor((mins % 1440) / 60);
    const rem = mins % 60;
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${rem}m`;
    return `${rem}m`;
  }

  const expiresSoon = (expiresAt: string) => new Date(expiresAt).getTime() - Date.now() < 12 * 60 * 60 * 1000;
</script>

{#if error}
  <div class="ui-panel error">
    <p class="font-bold">{t("classTime.snippetsError")}</p>
    <p class="text-sm">{error}</p>
  </div>
{:else if rows.length === 0}
  <div class="ui-panel empty">
    <p class="ui-title">{t("classTime.snippetsEmpty")}</p>
    <p class="ui-muted">{t("classTime.snippetsEmptyHint")}</p>
  </div>
{:else}
  <div class="table-wrap overflow-x-auto">
    <table class="table">
      <thead>
        <tr>
          <th>{t("classTime.snippetStudent")}</th>
          <th>{t("classTime.snippetTitle")}</th>
          <th>{t("classTime.snippetLo")}</th>
          <th>{t("classTime.snippetShared")}</th>
          <th>{t("classTime.snippetExpires")}</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {#each rows as row (row.id)}
          <tr>
            <td>
              <div class="flex items-center gap-2">
                <StudentAvatar fullName={row.learnerName || row.learnerId} avatarUrl={row.avatarUrl} size="size-7" initialClass="text-xs" />
                <span class="truncate">{row.learnerName || row.learnerId}</span>
              </div>
            </td>
            <td class="max-w-[20ch] truncate">{row.title || row.filename || "—"}</td>
            <td class="max-w-[24ch] truncate">{row.loTitle || row.loRoute || "—"}</td>
            <td>{formatDateTime(row.createdAt)}</td>
            <td class={expiresSoon(row.expiresAt) ? "soon" : ""}>{timeLeft(row.expiresAt)}</td>
            <td class="text-right">
              <button type="button" class="ui-button" aria-expanded={expanded === row.id} onclick={() => toggle(row.id)}>
                {expanded === row.id ? t("classTime.snippetHide") : t("classTime.snippetView")}
              </button>
            </td>
          </tr>
          {#if expanded === row.id}
            <tr>
              <td colspan="6">
                <div class="space-y-2 p-2">
                  {#if row.filename}<p class="ui-muted font-mono text-xs">{row.filename}</p>{/if}
                  <pre class="snippet-body">{row.content}</pre>
                </div>
              </td>
            </tr>
          {/if}
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<style>
  .empty, .error { padding: var(--space-8); text-align: center; }
  .error { color: var(--ui-danger); }
  .soon { color: var(--ui-danger); font-weight: var(--weight-semibold); }
  .snippet-body { max-height: 24rem; overflow: auto; padding: var(--space-3); border-radius: var(--radius-control); background: var(--ui-canvas); font-size: var(--font-label); white-space: pre-wrap; word-break: break-word; }
</style>
