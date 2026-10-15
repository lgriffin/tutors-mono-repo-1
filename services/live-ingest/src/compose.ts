/**
 * The ingest service's composition root: which adapter sits behind the LivePresenceStore and the
 * LiveWarehouse, decided from `LIVE_*` and nowhere else. The bus is always Redis Streams here -
 * on the in-memory bus the events never leave the live app's process, so there is nothing for a
 * separate consumer to read, and `main.ts` says so rather than sitting silently idle.
 */
import type { LiveBus, LivePresenceStore, LiveWarehouse } from "@tutors/application/ports";
import { inMemoryLiveBus, inMemoryPresenceStore, inMemoryWarehouse } from "@tutors/application/testing";
import { connectRedis, redisLiveBus, valkeyPresenceStore } from "@tutors/live-redis";
import { connectPostgres, postgresWarehouse } from "@tutors/live-postgres";

type Env = Record<string, string | undefined>;

export interface IngestConfig {
  bus: "memory" | "redis";
  hotStore: "memory" | "valkey";
  warehouse: "memory" | "postgres";
  redisUrl?: string;
  databaseUrl?: string;
  retentionDays: number;
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** Reads the same `LIVE_*` variables the live app reads. */
export function ingestConfigFromEnv(env: Env): IngestConfig {
  return {
    bus: oneOf(env.LIVE_BUS, ["memory", "redis"] as const, "memory"),
    hotStore: oneOf(env.LIVE_HOT_STORE, ["memory", "valkey"] as const, "memory"),
    warehouse: oneOf(env.LIVE_WAREHOUSE, ["memory", "postgres"] as const, "memory"),
    redisUrl: env.LIVE_REDIS_URL,
    databaseUrl: env.LIVE_DATABASE_URL,
    retentionDays: Number(env.LIVE_RETENTION_DAYS ?? 90)
  };
}

export interface IngestPipeline {
  bus: LiveBus;
  hot: LivePresenceStore;
  warehouse: LiveWarehouse;
  close(): Promise<void>;
}

export async function composeIngest(config: IngestConfig): Promise<IngestPipeline> {
  const closers: (() => Promise<void>)[] = [];

  let bus: LiveBus;
  if (config.bus === "redis") {
    const url = required(config.redisUrl, "LIVE_REDIS_URL");
    const client = await connectRedis(url);
    const reader = await connectRedis(url);
    bus = redisLiveBus({ client, reader });
    closers.push(async () => {
      await client.quit();
      await reader.quit();
    });
  } else {
    bus = inMemoryLiveBus();
  }

  const hot = config.hotStore === "valkey" ? valkeyPresenceStore(await connectRedis(required(config.redisUrl, "LIVE_REDIS_URL"))) : inMemoryPresenceStore();

  let warehouse: LiveWarehouse;
  if (config.warehouse === "postgres") {
    const postgres = postgresWarehouse(await connectPostgres(required(config.databaseUrl, "LIVE_DATABASE_URL")));
    await postgres.migrate();
    warehouse = postgres;
  } else {
    warehouse = inMemoryWarehouse({ retentionDays: config.retentionDays });
  }

  return {
    bus,
    hot,
    warehouse,
    async close(): Promise<void> {
      await bus.close();
      await hot.close();
      await warehouse.close();
      for (const closer of closers) await closer();
    }
  };
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} must be set`);
  return value;
}
