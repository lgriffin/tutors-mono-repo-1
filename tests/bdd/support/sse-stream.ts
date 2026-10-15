/** One `data:` frame of a realtime stream: the hub message the server sent. */
type Frame = { event: string; payload: unknown; from?: string };

/** A browser reading a server-sent event stream: every `data:` frame it has received, parsed. */
export type OpenStream = { response: Response; frames: Frame[]; close(): Promise<void> };

export function readStream(response: Response): OpenStream {
  const frames: Frame[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      buffered += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffered.indexOf("\n\n")) >= 0) {
        const block = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        for (const line of block.split("\n")) if (line.startsWith("data: ")) frames.push(JSON.parse(line.slice(6)) as Frame);
      }
    }
  })();
  return { response, frames, close: () => reader.cancel() };
}
