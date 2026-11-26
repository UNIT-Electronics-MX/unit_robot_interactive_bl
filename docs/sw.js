const CACHE_NAME = "unit-spider-ble-v17";
const FILES = [
  "./", "./index.html", "./styles.css?v=17", "./app.js?v=17", "./robot-profile.js?v=9", "./sesame-moves.js?v=13", "./robot-core.js?v=12", "./manifest.webmanifest",
  "./icons/spider.svg", "./icons/spider-192.png", "./icons/spider-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(names
      .filter((name) => name.startsWith("unit-spider-ble-") && name !== CACHE_NAME)
      .map((name) => caches.delete(name)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).catch(() => caches.match("./index.html")));
    return;
  }
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});
