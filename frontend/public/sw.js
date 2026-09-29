const CACHE_NAME = "depth-wizard-v2";
const ASSETS = ["/", "/index.html", "/manifest.json", "/icons/icon.svg"];
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)));
  self.skipWaiting();
});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith("depth-wizard-") && key !== CACHE_NAME).map(key => caches.delete(key))
  )).then(() => self.clients.claim()));
});
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  const navigation = event.request.mode === "navigate";
  const staticAsset = url.pathname.startsWith("/assets/") || url.pathname.startsWith("/icons/") ||
    ["/", "/index.html", "/manifest.json"].includes(url.pathname);
  if (url.pathname === "/api" || url.pathname.startsWith("/api/") ||
      (!navigation && !staticAsset)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    if (!navigation && url.pathname !== "/index.html" && url.pathname !== "/") {
      const hit = await cache.match(event.request);
      if (hit) return hit;
    }
    try {
      const response = await fetch(event.request);
      if (response.ok && (staticAsset || response.headers.get("content-type")?.includes("text/html"))) {
        await cache.put(event.request, response.clone());
      }
      return response;
    } catch {
      return await cache.match(event.request) ||
        (navigation ? await cache.match("/index.html") : null) || Response.error();
    }
  })());
});
