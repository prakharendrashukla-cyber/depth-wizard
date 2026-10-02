const API_BASE = (import.meta.env?.VITE_API_BASE || "/api").replace(/\/$/, "");
import { supabase } from "./supabase/client.js";
import { authProvider, publicDemoOnly } from "./runtimeConfig.js";
export class ApiError extends Error {
  constructor(message, status) { super(message); this.name = "ApiError"; this.status = status; }
}
/** Cookie-aware transport; keeps the Response interface for binary exports. */
export async function apiFetch(path, options = {}) {
  if (publicDemoOnly) throw new ApiError("Cloud analysis is disabled on this public demo.", 403);
  const relative = path.replace(/^\/api(?=\/|$)/, "");
  if (!relative.startsWith("/") || relative.startsWith("//")) throw new Error("Use a relative API path");
  const headers = new Headers(options.headers);
  const cloud = authProvider === "supabase";
  if (cloud) {
    if (supabase) {
      // getSession is for retrieving a token; the backend verifies its signature.
      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;
      if (data.session) headers.set("Authorization", `Bearer ${data.session.access_token}`);
    }
  }
  const response = await fetch(API_BASE + relative, { ...options, headers, credentials: cloud ? "same-origin" : "include" });
  const isJson = response.headers.get("content-type")?.includes("application/json");
  const data = isJson ? await response.clone().json().catch(() => null) : null;
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event("depthwizard:unauthorized"));
    const detail = data?.detail;
    const message = typeof detail === "string" ? detail
      : Array.isArray(detail) ? detail.map(item => item.msg).join("; ")
      : "Request failed. Please try again.";
    throw new ApiError(message, response.status);
  }
  if (isJson) response.json = async () => data;
  return response;
}
