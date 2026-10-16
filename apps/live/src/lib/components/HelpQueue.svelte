<script lang="ts">
  /**
   * A course's help queue in Tutors Live (Rules 0393, 0395, 0396, 0397): each live request with the
   * student and whether they are still online, the lab and step, the kind of help and the waiting
   * time ticking each second, lecturer requests first and then the longest waiting. The lecturer
   * acknowledges, answers a Need-a-hint request with a hint they type, or resolves. A request they
   * resolve or answer is offered as an explanation for everyone on its step, pre-filled with the
   * step and the hint (Rule 0407); explanations posted on the course show as they are heard (Rule 0405).
   */
  import { untrack } from "svelte";
  import { helpQueueService, placeOf } from "@tutors/svelte-state/assistance/queue";
  import type { HelpKind } from "@tutors/domain/assistance";
  import { t, type MessageKey } from "@tutors/i18n";

  let { courseId, online }: { courseId: string; online: (login: string) => boolean } = $props();

  // Only courseId drives this effect: start() and reset() read and write the service's runes, which
  // would otherwise make the effect depend on them and start the queue again on every read.
  $effect(() => {
    const id = courseId;
    if (!id) return;
    untrack(() => void helpQueueService.start(id));
    return () => untrack(() => helpQueueService.reset());
  });

  const rows = $derived(helpQueueService.rows(online));
  const status = $derived(helpQueueService.status.value);
  let hints = $state<Record<string, string>>({});

  const kindLabel = (kind: HelpKind) => t(`help.kind.${kind}` as MessageKey);
  function waited(ms: number): string {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const pad = (n: number) => String(n).padStart(2, "0");
    return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
  }
  const readAt = $derived(helpQueueService.readAt.value ? new Date(helpQueueService.readAt.value).toLocaleTimeString() : "");

  async function sendHint(id: string) {
    if (await helpQueueService.answerHint(id, hints[id] ?? "")) hints = { ...hints, [id]: "" };
  }

  let drafts = $state<Record<string, string>>({});
  const offers = $derived(helpQueueService.offers.value);
  const explanations = $derived(helpQueueService.explanations.value);
  const draft = (id: string) => drafts[id] ?? "";
  // Each offer starts from the step and the lecturer's hint, if they typed one (Rule 0407); the effect depends on the offers only.
  $effect(() => {
    const fresh = offers.filter((o) => untrack(() => drafts[o.id] === undefined));
    if (fresh.length) untrack(() => (drafts = { ...drafts, ...Object.fromEntries(fresh.map((o) => [o.id, helpQueueService.draftFor(o)])) }));
  });
  async function explain(id: string) {
    if (await helpQueueService.explain(id, draft(id))) drafts = { ...drafts, [id]: "" };
  }
</script>

<section class="ui-panel help-queue" aria-labelledby="help-queue-title">
  <div class="help-queue-head">
    <h2 id="help-queue-title" class="ui-section-title">{t("help.queue")} <span class="help-count">{rows.length}</span></h2>
    <p class="ui-muted">{t("help.queueSummary")}</p>
  </div>

  {#if status === "stale"}
    <p class="help-note" role="status">{t("help.stale")} {readAt}.</p>
  {/if}
  {#if helpQueueService.failure.value}
    <p class="help-note" role="alert">{t("help.actionFailed")}</p>
  {/if}

  {#if offers.length}
    <ol class="help-offers" aria-label={t("feedback.explain")}>
      {#each offers as o (o.id)}
        {@const where = placeOf(o.ref)}
        <li class="help-offer">
          <form
            onsubmit={(e) => {
              e.preventDefault();
              void explain(o.id);
            }}
          >
            <label class="ui-label" for="explain-{o.id}">{t("feedback.explainLabel")} {where.lab} · {where.step}</label>
            <textarea id="explain-{o.id}" rows="3" maxlength="4000" bind:value={drafts[o.id]}></textarea>
            <div class="help-actions">
              {#if helpQueueService.explainFailed.value}<span class="help-note" role="alert">{t("feedback.notSent")}</span>{/if}
              <button type="button" class="ui-button" onclick={() => helpQueueService.skipExplain(o.id)}>{t("feedback.cancel")}</button>
              <button type="submit" class="ui-button ui-button-primary" disabled={!draft(o.id).trim()}>{t("feedback.explainSend")}</button>
            </div>
          </form>
        </li>
      {/each}
    </ol>
  {/if}
  {#if explanations.length}
    <ul class="help-explanations" role="status">
      {#each explanations as a (a.id)}
        {@const where = placeOf(a.anchor.ref)}
        <li>{t("feedback.explanationPosted")} {where.lab} · {where.step} <span class="ui-muted">({a.authorId}, {new Date(a.createdAt).toLocaleTimeString()})</span></li>
      {/each}
    </ul>
  {/if}

  {#if status === "loading"}
    <p class="ui-muted">{t("help.loading")}</p>
  {:else if status === "refused"}
    <p class="ui-muted" role="status">{t("help.refused")}</p>
  {:else if rows.length === 0}
    <p class="ui-muted">{t("help.queueEmpty")}</p>
  {:else}
    <ol class="help-rows">
      {#each rows as row (row.request.id)}
        {@const r = row.request}
        {@const busy = helpQueueService.working.value.includes(r.id)}
        <li class="help-row" data-escalation={row.escalation} data-kind={r.kind}>
          <div class="help-who">
            <span class="help-presence" data-online={row.online} role="img" aria-label={row.online ? t("help.online") : t("help.offline")}></span>
            <span class="help-name">{r.learnerName || r.learnerId}</span>
          </div>
          <div class="help-where" title={`${r.ref.labRoute}/${r.ref.stepId}`}>{row.where.lab} · {row.where.step}</div>
          <div class="help-kind">
            {kindLabel(r.kind)}
            {#if row.escalation !== "none"}<span class="help-flag" data-escalation={row.escalation}>{t(row.escalation === "urgent" ? "help.urgent" : "help.escalated")}</span>{/if}
          </div>
          <div class="help-waited tabular-nums" aria-label="{t('help.waited')} {waited(row.waitingMs)}">{waited(row.waitingMs)}</div>
          <div class="help-actions">
            {#if r.state === "open"}
              <button type="button" class="ui-button" disabled={busy} onclick={() => helpQueueService.acknowledge(r.id)}>{t("help.acknowledge")}</button>
            {:else}
              <span class="ui-muted">{t("help.onTheWay")}</span>
            {/if}
            <button type="button" class="ui-button" disabled={busy} onclick={() => helpQueueService.resolve(r.id)}>{t("help.resolve")}</button>
          </div>
          {#if r.kind === "hint"}
            <form
              class="help-hint"
              onsubmit={(e) => {
                e.preventDefault();
                void sendHint(r.id);
              }}
            >
              <label class="ui-label" for="hint-{r.id}">{t("help.hintLabel")}</label>
              <textarea id="hint-{r.id}" rows="2" maxlength="2000" placeholder={t("help.hintPlaceholder")} bind:value={hints[r.id]}></textarea>
              <button type="submit" class="ui-button ui-button-primary" disabled={busy || !(hints[r.id] ?? "").trim()}>{t("help.answerHint")}</button>
            </form>
          {/if}
        </li>
      {/each}
    </ol>
  {/if}
</section>

<style>
  .help-queue-head {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    margin-bottom: var(--space-4);
  }
  .help-count {
    display: inline-block;
    min-width: 1.6em;
    padding: 0 var(--space-2);
    border-radius: 999px;
    background: var(--ui-selected);
    color: var(--ui-ink);
    font-size: var(--font-meta);
    text-align: center;
  }
  .help-note {
    margin-bottom: var(--space-3);
    color: var(--ui-warning);
    font-size: var(--font-meta);
  }
  .help-rows {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    list-style: none;
    padding: 0;
  }
  .help-row {
    display: grid;
    grid-template-columns: minmax(8rem, 1.4fr) minmax(8rem, 1.4fr) minmax(8rem, 1.2fr) 5rem auto;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3);
    border: 1px solid var(--ui-border);
    border-radius: 8px;
  }
  .help-row[data-kind="lecturer"] {
    border-inline-start: 3px solid var(--ui-brand);
  }
  .help-row[data-escalation="urgent"] {
    border-color: var(--ui-danger);
  }
  .help-who {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
  }
  .help-name,
  .help-where {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .help-presence {
    flex: 0 0 auto;
    width: 8px;
    height: 8px;
    border-radius: 999px;
    background: var(--ui-disabled-ink);
  }
  .help-presence[data-online="true"] {
    background: var(--ui-success);
  }
  .help-flag {
    margin-inline-start: var(--space-2);
    padding: 0 var(--space-2);
    border-radius: 999px;
    font-size: var(--font-caption);
    color: var(--ui-ink);
    border: 1px solid var(--ui-warning);
  }
  .help-flag[data-escalation="urgent"] {
    border-color: var(--ui-danger);
    color: var(--ui-danger);
  }
  .help-waited {
    font-variant-numeric: tabular-nums;
  }
  .help-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: var(--space-2);
  }
  .help-hint {
    grid-column: 1 / -1;
    display: grid;
    grid-template-columns: 1fr auto;
    gap: var(--space-2);
    align-items: end;
  }
  .help-hint label {
    grid-column: 1 / -1;
  }
  .help-hint textarea {
    width: 100%;
    padding: var(--space-2);
    border: 1px solid var(--ui-control-border);
    border-radius: 6px;
    background: var(--ui-surface);
    color: var(--ui-ink);
  }
  .help-offers,
  .help-explanations {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-bottom: var(--space-4);
    list-style: none;
    padding: 0;
  }
  .help-offer form {
    display: grid;
    gap: var(--space-2);
    padding: var(--space-3);
    border: 1px solid var(--ui-brand);
    border-radius: 8px;
  }
  .help-offer textarea {
    width: 100%;
    padding: var(--space-2);
    border: 1px solid var(--ui-control-border);
    border-radius: 6px;
    background: var(--ui-surface);
    color: var(--ui-ink);
  }
  .help-explanations li {
    font-size: var(--font-meta);
  }
  @media (max-width: 767px) {
    .help-row {
      grid-template-columns: 1fr auto;
    }
    .help-actions {
      grid-column: 1 / -1;
      justify-content: flex-start;
    }
  }
</style>
