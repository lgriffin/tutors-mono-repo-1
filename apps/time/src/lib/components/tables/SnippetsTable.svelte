<script lang="ts">
  import type { SharedSnippet } from "@tutors/application/ports";
  import { t } from "@tutors/i18n";
  import StudentAvatar from "#lib/components/StudentAvatar.svelte";
  import { adapters } from "@tutors/svelte-state/adapters";
  import { stepRefOfRoute } from "@tutors/domain/learning";

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

  /**
   * A lecturer's feedback to the student on their snippet, which is their submission at the step it
   * was shared from: posted through the reader's /api/feedback with the session, it shows under that
   * step for that student only (Rules 0400, 0403).
   */
  let feedback = $state<Record<string, string>>({});
  let sent = $state<Record<string, "sent" | "failed" | "sending">>({});

  async function sendFeedback(row: SharedSnippet) {
    const ref = stepRefOfRoute(row.courseId, row.loRoute);
    const body = feedback[row.id] ?? "";
    if (!ref || !body.trim() || sent[row.id] === "sending") return;
    sent = { ...sent, [row.id]: "sending" };
    const result = await adapters().feedbackDesk.annotate({ ref, snippetId: row.id }, { learnerId: row.learnerId }, body);
    sent = { ...sent, [row.id]: result.ok ? "sent" : "failed" };
    if (result.ok) feedback = { ...feedback, [row.id]: "" };
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
                  {#if stepRefOfRoute(row.courseId, row.loRoute)}
                    <form
                      class="snippet-feedback"
                      onsubmit={(e) => {
                        e.preventDefault();
                        void sendFeedback(row);
                      }}
                    >
                      <label class="ui-label" for="snippet-feedback-{row.id}">{t("feedback.snippetLabel")}</label>
                      <textarea id="snippet-feedback-{row.id}" rows="3" maxlength="4000" bind:value={feedback[row.id]}></textarea>
                      <div class="snippet-feedback-actions">
                        {#if sent[row.id] === "sent"}<span class="ui-muted" role="status">{t("feedback.sent")}</span>{/if}
                        {#if sent[row.id] === "failed"}<span class="failed" role="alert">{t("feedback.notSent")}</span>{/if}
                        <button type="submit" class="ui-button ui-button-primary" disabled={!(feedback[row.id] ?? "").trim() || sent[row.id] === "sending"}
                          >{t("feedback.snippet")}</button
                        >
                      </div>
                    </form>
                  {/if}
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
  .empty,
  .error {
    padding: var(--space-8);
    text-align: center;
  }
  .error {
    color: var(--ui-danger);
  }
  .soon {
    color: var(--ui-danger);
    font-weight: var(--weight-semibold);
  }
  .snippet-feedback {
    display: grid;
    gap: var(--space-2);
  }
  .snippet-feedback textarea {
    width: 100%;
    padding: var(--space-2);
    border: 1px solid var(--ui-control-border);
    border-radius: 6px;
    background: var(--ui-surface);
    color: var(--ui-ink);
  }
  .snippet-feedback-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-3);
  }
  .failed {
    color: var(--ui-danger);
    font-size: var(--font-meta);
  }
  .snippet-body {
    max-height: 24rem;
    overflow: auto;
    padding: var(--space-3);
    border-radius: var(--radius-control);
    background: var(--ui-canvas);
    font-size: var(--font-label);
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
