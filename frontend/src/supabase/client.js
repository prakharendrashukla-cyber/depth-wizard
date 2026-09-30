import { createClient } from "@supabase/supabase-js";

export const cloudMode = import.meta.env?.VITE_AUTH_PROVIDER === "supabase";
const url = import.meta.env?.VITE_SUPABASE_URL;
const key = import.meta.env?.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env?.VITE_SUPABASE_ANON_KEY;
// Publishable/anon keys identify the project. RLS protects the data.
// A secret/service_role key must NEVER be put in a VITE_ variable.
if (key?.startsWith("sb_secret_")) throw new Error("Use a Supabase publishable key, never a secret key");
export const supabase = cloudMode && url && key ? createClient(url, key, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce" },
}) : null;
export function requireSupabase() {
  if (!supabase) throw new Error("Cloud history is not configured yet. You can still try the app as a guest.");
  return supabase;
}
export const authRedirect = () => new URL(import.meta.env?.VITE_AUTH_REDIRECT_URL || "/", window.location.origin).href;
