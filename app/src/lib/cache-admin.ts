// app/src/lib/cache-admin.ts
// Browser-side cache/service-worker teardown. Kept apart from lib/sw-cache.ts
// (pure rules, unit-tested) because everything here touches real browser APIs.
import { BUCKET_PREFIX } from "./sw-cache";

/** Delete every cache bucket this app owns. Buckets owned by others survive. */
export async function clearAppCaches(): Promise<void> {
  if (!("caches" in globalThis)) return;
  const keys = await caches.keys();
  await Promise.all(keys.filter((k) => k.startsWith(BUCKET_PREFIX)).map((k) => caches.delete(k)));
}

/** Unregister every service worker for this origin. */
export async function unregisterServiceWorkers(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  const regs = await navigator.serviceWorker.getRegistrations();
  await Promise.all(regs.map((r) => r.unregister()));
}

/**
 * Full teardown: drop caches, drop workers, then reload. Used both after an OTA
 * version bump and by the manual "clear cache" button in Settings.
 * Best-effort — a failure here must never leave the user stuck, so we reload
 * regardless.
 */
export async function hardReset(): Promise<void> {
  try {
    await clearAppCaches();
    await unregisterServiceWorkers();
  } catch {
    /* best-effort: reload anyway */
  }
  location.reload();
}
