/**
 * Sharing a snippet from the reader (issue #155): the learner's paste goes to the SnippetStore the
 * app composed, which in the browser is the reader's own server. Plain TypeScript, no runes.
 */
import type { SnippetInput } from "@tutors/application";
import { MAX_SNIPPET_BYTES, snippetBytes } from "@tutors/application";
import { adapters } from "../../adapters.ts";

export type ShareOutcome = { ok: true; id: string } | { ok: false; message: string | null };

export const snippetService = {
  /** False in the anonymous reader: there is nobody to share as and nowhere to keep it. */
  enabled(): boolean {
    return !adapters().anonymous;
  },

  maxBytes: MAX_SNIPPET_BYTES,
  bytesOf: snippetBytes,

  /** Hands the snippet to the store; `message` carries the server's reason when it refused. */
  async share(input: SnippetInput, learner: { login: string; name: string | null }): Promise<ShareOutcome> {
    if (adapters().anonymous) return { ok: false, message: null };
    try {
      const id = await adapters().snippets.add({
        courseId: input.courseId,
        learnerId: learner.login,
        learnerName: learner.name,
        filename: input.filename.trim() || "snippet.txt",
        content: input.content,
        title: input.title?.trim() || null,
        loRoute: input.loRoute?.trim() || null,
        loTitle: input.loTitle?.trim() || null,
        // The server computes the expiry; the browser's value is a placeholder it ignores.
        expiresAt: ""
      });
      return { ok: true, id };
    } catch (error) {
      return { ok: false, message: error instanceof Error && error.message ? error.message : null };
    }
  }
};
