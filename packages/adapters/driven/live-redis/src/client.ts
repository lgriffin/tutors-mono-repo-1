/**
 * The one place this adapter touches the driver.
 *
 * `redis` is loaded lazily, so a deployment running on the in-memory adapters never pays for it
 * and never fails to start because it is missing. Everything else in the package talks to the
 * narrow slice below, which is what lets the adapter be tested against a fake.
 */

/** The slice of node-redis (and therefore of Valkey) the adapter uses. */
export interface RedisClient {
  xAdd(key: string, id: string, message: Record<string, string>): Promise<string>;
  xRead(
    streams: { key: string; id: string } | { key: string; id: string }[],
    options?: { BLOCK?: number; COUNT?: number }
  ): Promise<{ name: string; messages: { id: string; message: Record<string, string> }[] }[] | null>;
  zAdd(key: string, members: { score: number; value: string }): Promise<number>;
  zRem(key: string, member: string): Promise<number>;
  zRemRangeByScore(key: string, min: number | string, max: number | string): Promise<number>;
  /** Always called with `{ BY: "SCORE" }`: the default ranges by index, not by score. */
  zRangeWithScores(key: string, min: number, max: number, options: { BY: "SCORE" }): Promise<{ value: string; score: number }[]>;
  expire(key: string, seconds: number): Promise<boolean | number>;
  keys(pattern: string): Promise<string[]>;
  quit(): Promise<unknown>;
}

/** Connects to Valkey/Redis. Throws with a usable message when `redis` is not installed. */
export async function connectRedis(url: string): Promise<RedisClient> {
  const specifier = "redis";
  let redis: { createClient: (options: { url: string }) => RedisClient & { connect(): Promise<unknown> } };
  try {
    const loaded = (await import(/* @vite-ignore */ specifier)) as typeof redis & { default?: typeof redis };
    redis = loaded.default ?? loaded;
  } catch (cause) {
    throw new Error(`LIVE_HOT_STORE=valkey and LIVE_BUS=redis need the \`redis\` package (importing "redis" failed)`, { cause });
  }
  const client = redis.createClient({ url });
  await client.connect();
  return client;
}
