/**
 * Tutors Live on TimescaleDB: the LiveWarehouse adapter. The only package that imports the `pg`
 * driver, lazily, behind `connectPostgres`; the schema ships as a string so it survives bundling.
 */
export { connectPostgres, type SqlClient } from "./client.ts";
export { postgresWarehouse } from "./warehouse.ts";
export { LIVE_SCHEMA_SQL } from "./schema.ts";
