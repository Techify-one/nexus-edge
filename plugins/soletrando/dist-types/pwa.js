export const SOLETRANDO_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Soletrando">
  <rect width="64" height="64" rx="16" fill="#4f46e5"/>
  <path d="M18 16h28a4 4 0 0 1 4 4v28H22a8 8 0 0 1-8-8V20a4 4 0 0 1 4-4Z" fill="#fff"/>
  <path d="M22 24h20M22 32h16M22 40h12" stroke="#4f46e5" stroke-width="4" stroke-linecap="round"/>
</svg>`;
export const SOLETRANDO_SERVICE_WORKER = `const CACHE_PREFIX = "soletrando-shell-";
const CACHE = CACHE_PREFIX + "v1.1.3";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE)
          .map((key) => caches.delete(key)),
      ),
    ),
  );
  self.clients.claim();
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== "GET" ||
    url.origin !== self.location.origin ||
    (!url.pathname.startsWith("/soletrando/") &&
      !url.pathname.startsWith("/assets/"))
  ) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok)
          event.waitUntil(
            caches.open(CACHE).then((cache) =>
              cache.put(event.request, response.clone()),
            ),
          );
        return response;
      })
      .catch(() => caches.match(event.request)),
  );
});
`;
const startPathPattern = /^\/soletrando\/c\/[A-Za-z0-9_-]{32,128}$/u;
export function soletrandoManifest(startPath) {
    return {
        name: "Soletrando",
        short_name: "Soletrando",
        description: "Treino divertido de soletração em português.",
        start_url: startPath && startPathPattern.test(startPath)
            ? startPath
            : "/soletrando/",
        scope: "/soletrando/",
        display: "standalone",
        background_color: "#f8fafc",
        theme_color: "#4f46e5",
        orientation: "portrait",
        icons: [
            {
                src: "/api/v1/public/p/soletrando/pwa/icon.svg",
                sizes: "any",
                type: "image/svg+xml",
                purpose: "any",
            },
        ],
    };
}
