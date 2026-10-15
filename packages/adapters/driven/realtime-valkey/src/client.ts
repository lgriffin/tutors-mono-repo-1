/**
 * The one place this adapter touches the driver.
 *
 * `redis` (node-redis, which speaks to Valkey) is loaded lazily, so a deployment on Supabase
 * Realtime never pays for it and a browser bundle never sees it. Everything else in the package
 * talks to the narrow slice below, which a test implements with a fake.
 */
import log from "@tutors/logger";

/** The slice of node-redis the hub uses: PUBLISH on one connection, SUBSCRIBE on another. */
export interface PubSubClient {
  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string, listener: (message: string) => void): Promise<unknown>;
  unsubscribe(channel: string): Promise<unknown>;
  quit(): Promise<unknown>;
}

/** A publisher and the subscriber connection SUBSCRIBE needs to itself. */
export interface PubSubPair {
  publisher: PubSubClient;
  subscriber: PubSubClient;
}

type DriverClient = PubSubClient & {
  connect(): Promise<unknown>;
  duplicate(): DriverClient;
  on(event: "error", listener: (error: unknown) => void): unknown;
};

/** Connects both connections. Throws with a usable message when `redis` is not installed. */
export async function connectValkey(url: string): Promise<PubSubPair> {
  const specifier = "redis";
  let redis: { createClient: (options: { url: string }) => DriverClient };
  try {
    const loaded = (await import(/* @vite-ignore */ specifier)) as typeof redis & { default?: typeof redis };
    redis = loaded.default ?? loaded;
  } catch (cause) {
    throw new Error('PUBLIC_REALTIME=valkey needs the `redis` package (importing "redis" failed)', { cause });
  }
  const publisher = redis.createClient({ url });
  const subscriber = publisher.duplicate();
  // node-redis emits "error" on every lost connection and reconnects by itself; an unheard
  // "error" event would end the server instead.
  publisher.on("error", (error) => log.warn("Valkey publisher connection error:", error));
  subscriber.on("error", (error) => log.warn("Valkey subscriber connection error:", error));
  await Promise.all([publisher.connect(), subscriber.connect()]);
  return { publisher, subscriber };
}
