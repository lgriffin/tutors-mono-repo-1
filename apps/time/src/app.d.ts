// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import type { Actor } from "@tutors/identity";

declare global {
  const APP_VERSION: string;

  namespace App {
    // interface Error {}
    interface Locals {
      /** Verified identity for this request, resolved by the identity adapter; the educator check reads its login. */
      actor: Actor | null;
      /** Correlation id set by the request logger hook; echoed as x-request-id. */
      requestId?: string;
    }
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }
}

export {};
