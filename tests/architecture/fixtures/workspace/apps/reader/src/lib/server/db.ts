// Clean: server-only code of an app may build the database client (its service key never reaches a browser).
import { createClient } from "@supabase/supabase-js";
export const db = createClient();
