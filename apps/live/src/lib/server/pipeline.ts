/**
 * The live pipeline's composition: which adapter sits behind the LiveBus, the LivePresenceStore
 * and the LiveWarehouse, decided from `LIVE_*` and nowhere else. Every seam defaults to the
 * in-memory adapter, so a single `tutors-live` container is a complete, working pipeline and a
 * production deployment is the same code with three variables set. `services/live-ingest` has a
 * composition root of its own for the deployment where the consumer runs outside the app.
 */
import { parseTerms, type TermWindow } from "@tutors/domain/live";
import type { LiveBus, LivePresenceStore, LiveWarehouse } from "@tutors/application/ports";
import { inMemoryLiveBus, inMemoryPresenceStore, inMemoryWarehouse } from "@tutors/application/testing";
import { connectRedis, redisLiveBus, valkeyPresenceStore } from "@tutors/live-redis";
import { connectPostgres, postgresWarehouse } from "@tutors/live-postgres";

type BusKind = "memory" | "redis";
type HotStoreKind = "memory" | "valkey";
type WarehouseKind = "memory" | "postgres";

export interface LiveConfig {
  bus: BusKind;
  hotStore: HotStoreKind;
  warehouse: WarehouseKind;
  /** Valkey/Redis connection string, for the `redis` and `valkey` adapters. */
  redisUrl?: string;
  /** TimescaleDB connection string, for the `postgres` adapter. */
  databaseUrl?: string;
  retentionDays: number;
  /**
   * Whether the app process also runs the ingest consumer. True on the memory
   * bus, where nothing else can: the events never leave the process.
   */
  ingestInProcess: boolean;
  /** Term windows for the out-of-term rule, as `LIVE_TERMS` JSON. */
  terms: TermWindow[];
}

type Env = Record<string, string | undefined>;

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** Reads the configuration, falling back to the memory pipeline for anything unset or unrecognised. */
export function liveConfigFromEnv(env: Env): LiveConfig {
  const bus = oneOf(env.LIVE_BUS, ["memory", "redis"] as const, "memory");
  return {
    bus,
    hotStore: oneOf(env.LIVE_HOT_STORE, ["memory", "valkey"] as const, "memory"),
    warehouse: oneOf(env.LIVE_WAREHOUSE, ["memory", "postgres"] as const, "memory"),
    redisUrl: env.LIVE_REDIS_URL,
    databaseUrl: env.LIVE_DATABASE_URL,
    retentionDays: Number(env.LIVE_RETENTION_DAYS ?? 90),
    ingestInProcess: env.LIVE_INGEST_IN_PROCESS ? env.LIVE_INGEST_IN_PROCESS === "TRUE" : bus === "memory",
    terms: parseTerms(env.LIVE_TERMS)
  };
}

export interface LivePipeline {
  config: LiveConfig;
  bus: LiveBus;
  hot: LivePresenceStore;
  warehouse: LiveWarehouse;
  close(): Promise<void>;
}

let sharedBus: LiveBus | undefined;

/**
 * The process-wide in-memory bus. The ingest endpoint, the consumer and the SSE stream have to
 * be looking at the same instance for the memory deployment to work at all.
 */
function sharedMemoryBus(): LiveBus {
  sharedBus ??= inMemoryLiveBus();
  return sharedBus;
}

/** Drops the process-wide bus, so one test cannot leak subscribers into the next. */
export function resetSharedMemoryBus(): void {
  sharedBus = undefined;
}

/**
 * Builds the adapters this process needs.
 * @param options.shared use the process-wide memory bus (the app does, so its
 * ingest endpoint and its SSE stream meet; a test wants its own).
 */
export async function composeLivePipeline(config: LiveConfig, options: { shared?: boolean } = {}): Promise<LivePipeline> {
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
    bus = options.shared === false ? inMemoryLiveBus() : sharedMemoryBus();
  }

  let hot: LivePresenceStore;
  if (config.hotStore === "valkey") {
    hot = valkeyPresenceStore(await connectRedis(required(config.redisUrl, "LIVE_REDIS_URL")));
  } else {
    hot = inMemoryPresenceStore();
  }

  let warehouse: LiveWarehouse;
  if (config.warehouse === "postgres") {
    const postgres = postgresWarehouse(await connectPostgres(required(config.databaseUrl, "LIVE_DATABASE_URL")));
    await postgres.migrate();
    warehouse = postgres;
  } else {
    warehouse = inMemoryWarehouse({ retentionDays: config.retentionDays });
  }

  return {
    config,
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
