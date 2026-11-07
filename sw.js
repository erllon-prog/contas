// Service worker: guarda só os arquivos do app (nunca os dados do Supabase).
const CACHE = "contas-v11";
const SHELL = [
  "./", "index.html", "app.css?v=11", "app.js?v=11", "config.js?v=11", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png",
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// notificações (aviso diário de vencimento e pessoa nova para o administrador)
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : "" }; }
  const tarefas = [
    self.registration.showNotification(d.title || "Contas", {
      body: d.body || "",
      tag: d.tag || "contas",
      icon: "icons/icon-192.png",
      badge: "icons/icon-192.png",
      data: { url: d.url || "./" }
    })
  ];
  if (typeof d.badge === "number" && self.navigator && self.navigator.setAppBadge) {
    tarefas.push(self.navigator.setAppBadge(d.badge).catch(() => {}));
  }
  e.waitUntil(Promise.all(tarefas));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const alvo = new URL((e.notification.data && e.notification.data.url) || "./", self.registration.scope).href;
  e.waitUntil((async () => {
    const abertas = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of abertas) {
      if (c.url.startsWith(self.registration.scope)) {
        await c.focus();
        if (alvo !== c.url) c.postMessage({ tipo: "abrir", url: alvo });
        return;
      }
    }
    await self.clients.openWindow(alvo);
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const isShell = url.origin === self.location.origin || url.hostname === "cdn.jsdelivr.net";
  if (!isShell) return; // API, auth e storage do Supabase vão sempre direto para a rede

  // rede primeiro (pega atualizações), cache como reserva offline
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && !url.search.includes("code=")) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match("index.html")))
  );
});
