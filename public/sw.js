// Service worker: offline shell + APPROVAL-GATED updates (spec §10.1).
//
// The one thing this file must never do is call `skipWaiting()` during `install`. That is not a
// style preference — it is the whole mitigation spec §10.1 describes. A service worker that
// activates a new bundle the moment it downloads one means a compromised host can swap the
// decryption code under a user who is already unlocked, silently, between two keystrokes. With
// the default waiting behaviour left intact, a new bundle sits in `waiting` until the user is
// told and clicks; the running page keeps running the code it started with.
//
// Correspondingly: `skipWaiting()` is called ONLY from the message handler below, i.e. only as a
// direct consequence of that click. tests/e2e/pwa.spec.ts asserts against this file as served
// that no `skipWaiting` appears inside the install handler.

const CACHE = "eigenheim-shell-v1"

// The shell only — never `vault.age`, never anything from api.github.com. The vault is
// ciphertext that belongs in IndexedDB and on GitHub, and a copy of it in the Cache API would be
// a third place to leak from for no benefit.
const SHELL = ["/", "/index.html", "/manifest.webmanifest"]

self.addEventListener("install", (event) => {
  // Deliberately NO self.skipWaiting() here. See the header.
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // `reload` so an install never re-precaches a stale HTTP-cached copy of the shell.
      cache.addAll(SHELL.map((url) => new Request(url, { cache: "reload" }))),
    ),
  )
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)))
      await self.clients.claim()
    })(),
  )
})

self.addEventListener("fetch", (event) => {
  const request = event.request
  if (request.method !== "GET") return

  const url = new URL(request.url)
  // Same-origin only. A cached GitHub response would be both a privacy leak and a correctness
  // hazard (a stale `readHead` would make the app think the vault had not moved).
  if (url.origin !== self.location.origin) return

  event.respondWith(
    (async () => {
      const cached = await caches.match(request)
      if (cached) return cached
      try {
        const response = await fetch(request)
        // Only cache what the app actually needs offline, and only when it really succeeded.
        if (response.ok && (request.destination === "script" || request.destination === "style" || request.mode === "navigate")) {
          const cache = await caches.open(CACHE)
          cache.put(request, response.clone())
        }
        return response
      } catch (err) {
        // A navigation while offline falls back to the cached shell, which is the entire point:
        // unlock needs no network (spec §5.3), so the app is fully usable from here.
        if (request.mode === "navigate") {
          const shell = await caches.match("/index.html")
          if (shell) return shell
        }
        throw err
      }
    })(),
  )
})

self.addEventListener("message", (event) => {
  // The ONLY path to activation, reached only from the user's click on the update prompt.
  if (event.data === "SKIP_WAITING") self.skipWaiting()
})
