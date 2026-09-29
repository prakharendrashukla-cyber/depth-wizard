const API_BASE = (import.meta.env?.VITE_API_BASE || "/api").replace(/\/$/, "");
export class ApiError extends Error {
  constructor(message, status) { super(message); this.name = "ApiError"; this.status = status; }
}
/** Cookie-aware transport; keeps the Response interface for binary exports. */
export async function apiFetch(path, options = {}) {
  const relative = path.replace(/^\/api(?=\/|$)/, "");
  if (!relative.startsWith("/") || relative.startsWith("//")) throw new Error("Use a relative API path");
  const response = await fetch(API_BASE + relative, { ...options, credentials: "include" });
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
