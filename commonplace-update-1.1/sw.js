// Commonplace offline support. Bump VERSION whenever you upload new app files.
const VERSION = "commonplace-v1.1.0";
const SHELL = ["./", "./index.html", "./app.js", "./firebase-config.js", "./manifest.webmanifest", "./favicon.svg",
  "./icons/apple-touch-icon.png", "./icons/icon-192.png", "./icons/icon-512.png", "./vendor/jspdf.umd.min.js"];
const FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if(req.method !== "GET") return;
  const url = new URL(req.url);
  // App files: try the network first so updates arrive, fall back to the saved copy offline.
  if(url.origin === self.location.origin){
    e.respondWith(fetch(req).then(res => {
      if(res.ok){ const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, {ignoreSearch:true}).then(r => r || (req.mode === "navigate" ? caches.match("./index.html") : Response.error()))));
    return;
  }
  // Fonts: keep a copy so the app looks right offline.
  if(FONT_HOSTS.includes(url.hostname)){
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); return res; })));
  }
  // Everything else (Firebase sync and sign-in) goes straight to the network.
});
