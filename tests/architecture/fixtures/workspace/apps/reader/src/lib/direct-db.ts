// Violates no-database-client-in-browser-code: browser code of an app building the database client itself.
import { createClient } from "@supabase/supabase-js";
export const db = createClient();
