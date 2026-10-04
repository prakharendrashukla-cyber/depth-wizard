// Cloud Run supplies only public browser configuration before React loads.
export const runtimeConfig = typeof window === "undefined" ? {} : (window.__DEPTH_WIZARD_CONFIG__ || {});
export const publicDemoOnly = runtimeConfig.publicDemoOnly === true || import.meta.env?.VITE_PUBLIC_DEMO_ONLY === "true";
export const authProvider = runtimeConfig.authProvider || import.meta.env?.VITE_AUTH_PROVIDER || "local";
export const batchAnalysisEnabled = runtimeConfig.batchAnalysisEnabled === true;
export const videoAnalysisEnabled = runtimeConfig.videoAnalysisEnabled === true;
