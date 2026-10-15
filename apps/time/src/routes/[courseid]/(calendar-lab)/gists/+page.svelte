<script lang="ts">
  import SnippetsTable from "#lib/components/tables/SnippetsTable.svelte";
  import { page } from "$app/state";
  import { invalidateAll } from "$app/navigation";
  import { noticeService } from "@tutors/svelte-state/community";
  import { createIdentityClient } from "@tutors/identity-better-auth/client";
  import { t } from "@tutors/i18n";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  const courseId = $derived((page.params.courseid as string) ?? "");

  // Live updates: the ping is content-free, so the only thing to do on arrival is re-run the authorised load.
  $effect(() => {
    const id = courseId.trim();
    if (!id || !data.authorised) return;
    return noticeService.onSnippetShared(id, () => void invalidateAll());
  });

  const deniedMessage = $derived(
    !data.authorised && data.reason === "anonymous" ? t("classTime.snippetsSignIn") : !data.authorised && data.reason === "no-enrollment" ? t("classTime.snippetsNoEnrollment") : t("classTime.snippetsNotEducator")
  );

  function signIn() {
    void createIdentityClient().signIn(page.url.pathname);
  }
</script>

<svelte:head>
  <title>{t("classTime.snippets")}</title>
  <meta name="description" content={t("classTime.snippetsSummary")} />
</svelte:head>

{#key courseId}
  {#if !data.authorised}
    <div class="ui-panel denied">
      <h2 class="ui-title">{t("classTime.snippetsEducatorsOnly")}</h2>
      <p class="ui-muted">{deniedMessage}</p>
      {#if data.reason === "anonymous"}
        <button type="button" class="ui-button ui-button-primary" onclick={signIn}>{t("classTime.snippetsSignInButton")}</button>
      {/if}
    </div>
  {:else}
    <SnippetsTable rows={data.rows} error={data.error ?? null} />
  {/if}
{/key}

<style>
  .denied { display: grid; justify-items: center; gap: var(--space-3); padding: var(--space-8); text-align: center; }
</style>
