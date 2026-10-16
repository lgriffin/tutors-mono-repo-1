// Playwright waits for this before it runs the session specs.
export function GET() {
  return new Response("ready");
}
