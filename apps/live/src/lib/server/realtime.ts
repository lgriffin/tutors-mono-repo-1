import * as env from "$app/env/private";
import * as publicEnv from "$app/env/public";
import { realtimeHub, type RealtimeHub } from "@tutors/realtime-valkey";

/**
 * Tutors Live's side of realtime: the hub its stream route subscribes through, at the same
 * PRIVATE_VALKEY_URL the reader's server publishes to. Null in anonymous mode, where the route
 * answers 404.
 */
export function liveRealtimeHub(): RealtimeHub | null {
  if (publicEnv.PUBLIC_ANON_MODE?.trim().toUpperCase() === "TRUE") return null;
  return realtimeHub(env.PRIVATE_VALKEY_URL);
}
