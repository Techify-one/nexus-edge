const CHUNK_RELOAD_KEY = "nexus.chunk-reload-at";
const CHUNK_RELOAD_WINDOW_MS = 30_000;

export const shouldReloadChunk = (
  previousReloadAt: number,
  now: number,
): boolean => now - previousReloadAt > CHUNK_RELOAD_WINDOW_MS;

/**
 * A deployment changes lazy-loaded asset hashes. If an already-open tab asks
 * for an obsolete chunk, reload once so it receives the current asset map.
 */
export const registerChunkRecovery = (): void => {
  window.addEventListener("vite:preloadError", (event) => {
    let previousReloadAt = 0;
    const now = Date.now();
    try {
      previousReloadAt = Number(
        window.sessionStorage.getItem(CHUNK_RELOAD_KEY) || 0,
      );
    } catch {
      // A reload still recovers the page when session storage is unavailable.
    }

    if (!shouldReloadChunk(previousReloadAt, now)) return;
    event.preventDefault();
    try {
      window.sessionStorage.setItem(CHUNK_RELOAD_KEY, String(now));
    } catch {
      // Continue with the one recovery attempt available to this page load.
    }
    window.location.reload();
  });
};
