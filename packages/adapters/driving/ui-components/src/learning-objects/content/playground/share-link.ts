/**
 * The link form a workspace takes when it is shared with someone who has never signed in:
 * the files, deflated and base64url-encoded, in the URL fragment. Browser APIs throughout,
 * which is why this sits with the UI rather than in the domain.
 */
import type { WorkspaceFile } from "@tutors/domain/course/playground";

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((byte) => (binary += String.fromCharCode(byte)));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function squeeze(bytes: Uint8Array, mode: "deflate-raw" | "inflate-raw"): Promise<Uint8Array> {
  const stream = mode === "deflate-raw" ? new CompressionStream("deflate-raw") : new DecompressionStream("deflate-raw");
  const buffer = await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream as ReadableWritablePair)).arrayBuffer();
  return new Uint8Array(buffer);
}

/**
 * Pack a workspace into something that fits in a URL fragment.
 *
 * The fragment, not the query string: it never reaches a server, so sharing a link does not
 * hand anyone's code to the reader's host or its logs.
 */
export async function encodeShareLink(files: WorkspaceFile[], entry: string): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify({ v: 1, entry, files }));
  try {
    return toBase64Url(await squeeze(json, "deflate-raw"));
  } catch {
    return toBase64Url(json);
  }
}

export async function decodeShareLink(encoded: string): Promise<{ files: WorkspaceFile[]; entry: string } | null> {
  const read = (bytes: Uint8Array) => {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || !Array.isArray(parsed.files)) return null;
    return { files: parsed.files as WorkspaceFile[], entry: String(parsed.entry ?? "") };
  };
  try {
    const bytes = fromBase64Url(encoded);
    try {
      return read(await squeeze(bytes, "inflate-raw"));
    } catch {
      // Links made where CompressionStream was unavailable are plain JSON.
      return read(bytes);
    }
  } catch {
    return null;
  }
}
