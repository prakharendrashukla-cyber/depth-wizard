// Cloud Run supplies only public browser configuration before React loads.
export const runtimeConfig = typeof window === "undefined" ? {} : (window.__DEPTH_WIZARD_CONFIG__ || {});
export const authProvider = runtimeConfig.authProvider || import.meta.env?.VITE_AUTH_PROVIDER || "local";
