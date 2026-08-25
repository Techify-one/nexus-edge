export declare const SOLETRANDO_ICON_SVG = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\" role=\"img\" aria-label=\"Soletrando\">\n  <rect width=\"64\" height=\"64\" rx=\"16\" fill=\"#4f46e5\"/>\n  <path d=\"M18 16h28a4 4 0 0 1 4 4v28H22a8 8 0 0 1-8-8V20a4 4 0 0 1 4-4Z\" fill=\"#fff\"/>\n  <path d=\"M22 24h20M22 32h16M22 40h12\" stroke=\"#4f46e5\" stroke-width=\"4\" stroke-linecap=\"round\"/>\n</svg>";
export declare const SOLETRANDO_SERVICE_WORKER = "const CACHE_PREFIX = \"soletrando-shell-\";\nconst CACHE = CACHE_PREFIX + \"v1.1.3\";\nself.addEventListener(\"install\", () => self.skipWaiting());\nself.addEventListener(\"activate\", (event) => {\n  event.waitUntil(\n    caches.keys().then((keys) =>\n      Promise.all(\n        keys\n          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE)\n          .map((key) => caches.delete(key)),\n      ),\n    ),\n  );\n  self.clients.claim();\n});\nself.addEventListener(\"fetch\", (event) => {\n  const url = new URL(event.request.url);\n  if (\n    event.request.method !== \"GET\" ||\n    url.origin !== self.location.origin ||\n    (!url.pathname.startsWith(\"/soletrando/\") &&\n      !url.pathname.startsWith(\"/assets/\"))\n  ) return;\n  event.respondWith(\n    fetch(event.request)\n      .then((response) => {\n        if (response.ok)\n          event.waitUntil(\n            caches.open(CACHE).then((cache) =>\n              cache.put(event.request, response.clone()),\n            ),\n          );\n        return response;\n      })\n      .catch(() => caches.match(event.request)),\n  );\n});\n";
export declare function soletrandoManifest(startPath: string | null): {
    name: string;
    short_name: string;
    description: string;
    start_url: string;
    scope: string;
    display: string;
    background_color: string;
    theme_color: string;
    orientation: string;
    icons: {
        src: string;
        sizes: string;
        type: string;
        purpose: string;
    }[];
};
