<script lang="ts">
  import { page } from "$app/state";
  import PinDialog from "#lib/components/PinDialog.svelte";
  import SnippetListener from "#lib/components/SnippetListener.svelte";
  import type { TutorsTimeCourse } from "@tutors/tutors-time-lib";

  interface Props {
    data: { course: TutorsTimeCourse | null; isEducator: boolean };
    children: import("svelte").Snippet;
  }

  let { data, children }: Props = $props();
  let showPinDialog = $state(true);

  const courseId = $derived((page.params.courseid as string) ?? "");

  /**
   * The snippet dashboard is exempt from the PIN. The PIN is a course-wide shared secret guarding
   * class analytics from a projector; the dashboard is authorised per user, server-side, against
   * `enrollment.educators` before it returns a single row. Matched on the route id, not the
   * pathname: a course id may itself end in "gists".
   */
  const pinRequired = $derived(!page.route.id?.endsWith("/gists"));

  function onVerified() {
    showPinDialog = false;
  }
</script>

{#if pinRequired}
  <PinDialog
    open={showPinDialog}
    pin={data.course?.pin ?? ""}
    sessionKey={data.course?.id}
    onVerified={onVerified}
  />
{/if}

<!-- Snippet toasts are for educators only, so the listener mounts behind the server-side check. -->
{#if data.isEducator}
  <SnippetListener {courseId} />
{/if}

{@render children()}
