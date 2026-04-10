import { createClient as createSupabaseClient, SupabaseClient } from "@supabase/supabase-js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: SupabaseClient<any, any, any> | null = null;

export function createClient() {
  if (client) return client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;

  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in environment");
  }

  client = createSupabaseClient<any, any, any>(url, key);
  return client;
}

export function getUserId() {
  const id = process.env.INTEND_USER_ID;
  if (!id) {
    throw new Error("Missing INTEND_USER_ID in environment");
  }
  return id;
}
