// Service worker do Semeia (igual ao da AgroPool): deixa o CRM instalável como app no celular
// e, só quando a navegação falha por falta de internet, mostra /offline.html em vez do erro do navegador.
// Não guarda nenhuma outra página nem dado: com conexão, o app sempre abre a versão mais nova.
// Quando o Semeia tiver notificações push, elas entram aqui (evento "push").
const OFFLINE_CACHE = 'semeia-offline-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(OFFLINE_CACHE).then((c) => c.addAll(['/offline.html', '/logo.svg'])).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== OFFLINE_CACHE).map((k) => caches.delete(k))))
    .catch(() => {}).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  // Só páginas (navegação). API, imagens e scripts passam direto, intactos.
  if (event.request.mode !== 'navigate') return;
  event.respondWith(fetch(event.request).catch(() => caches.match('/offline.html').then((r) => r || Response.error())));
});
