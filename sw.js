// ============================================================
// Cysy Fertilizantes — Service Worker (v3)
// Estratégia: network-first + cache controlado com poda automática
// Melhorias: timeouts, melhor tratamento de erro, versionamento robusto
// ============================================================

const CACHE_VERSION = 'cysy-v5-prod';
const CACHE_STATIC = `${CACHE_VERSION}-static`;
const CACHE_RUNTIME = `${CACHE_VERSION}-runtime`;
const APP_CACHE_PREFIX = 'cysy-';
const MAX_RUNTIME_ENTRIES = 120;

// PRECACHE_ASSETS: lista mínima, com verificação de existência
const PRECACHE_ASSETS = [
  './offline.html',
  './manifest.webmanifest',
  './icons/icon.svg'
];

// Log seguro para SW
const swLog = (msg, level = 'info') => {
  const levels = { error: '❌', warn: '⚠️', info: 'ℹ️', success: '✅' };
  console.log(`[SW] ${levels[level] || '•'} ${msg}`);
};

const isExternalHost = (url) =>
  url.hostname.includes('googleapis.com') ||
  url.hostname.includes('script.google.com') ||
  url.hostname.includes('fonts.googleapis.com') ||
  url.hostname.includes('fonts.gstatic.com');

const shouldCacheRequest = (request) => {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url);
  if (isExternalHost(url)) return false;
  if (request.destination === 'document') return false;
  if (request.destination === 'style' || request.destination === 'script' || request.destination === 'image' || request.destination === 'font') return true;
  const pathname = url.pathname.toLowerCase();
  return pathname.endsWith('.html') || pathname.endsWith('.css') || pathname.endsWith('.js') || pathname.endsWith('.json') || pathname.endsWith('.svg') || pathname.endsWith('.png') || pathname.endsWith('.jpg') || pathname.endsWith('.jpeg') || pathname.endsWith('.webp');
};

const pruneRuntimeCache = async () => {
  const runtime = await caches.open(CACHE_RUNTIME);
  const keys = await runtime.keys();
  if (keys.length <= MAX_RUNTIME_ENTRIES) return 0;
  const toDelete = keys.slice(0, keys.length - MAX_RUNTIME_ENTRIES);
  await Promise.all(toDelete.map((req) => runtime.delete(req)));
  return toDelete.length;
};

const removeLegacyCaches = async () => {
  const keys = await caches.keys();
  const legacy = keys.filter((key) => key.startsWith(APP_CACHE_PREFIX) && key !== CACHE_STATIC && key !== CACHE_RUNTIME);
  await Promise.all(legacy.map((key) => caches.delete(key)));
  return legacy.length;
};

self.addEventListener('install', (event) => {
  swLog('Install iniciado', 'info');
  event.waitUntil(
    caches.open(CACHE_STATIC)
      .then((cache) => {
        swLog('Cache aberto, adicionando assets...', 'info');
        // Adicionar cada asset individualmente com fallback
        return Promise.all(
          PRECACHE_ASSETS.map((asset) =>
            fetch(asset)
              .then((response) => {
                if (response.ok) {
                  return cache.put(asset, response);
                } else {
                  swLog(`Asset ${asset} retornou HTTP ${response.status}`, 'warn');
                }
              })
              .catch((err) => {
                swLog(`Falha ao cachear ${asset}: ${err.message}`, 'warn');
                // Continua mesmo se 1 asset falhar
              })
          )
        );
      })
      .then(() => {
        swLog('Precache concluído', 'success');
        return self.skipWaiting();
      })
      .catch((err) => {
        swLog(`Install erro: ${err.message}`, 'error');
        // Não falhar completamente — continua mesmo sem precache perfeito
      })
  );
});

self.addEventListener('activate', (event) => {
  swLog('Activate iniciado', 'info');
  event.waitUntil(
    Promise.all([
      self.registration.navigationPreload?.enable().catch(() => {}),
      removeLegacyCaches().catch(err => {
        swLog(`Erro ao remover caches legados: ${err.message}`, 'warn');
        return 0;
      }),
      pruneRuntimeCache().catch(err => {
        swLog(`Erro ao fazer prune: ${err.message}`, 'warn');
        return 0;
      })
    ])
      .then(([removedLegacy, prunedItems]) => {
        swLog(`Activate: ${removedLegacy} caches legados removidos, ${prunedItems} items podados`, 'success');
        return self.clients.claim();
      })
      .catch(err => {
        swLog(`Activate erro: ${err.message}`, 'error');
      })
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);

  if (isExternalHost(url)) {
    // Externa: network-first com timeout
    event.respondWith((async () => {
      try {
        const timeout = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Timeout')), 8000)
        );
        const networkResponse = await Promise.race([fetch(event.request), timeout]);
        return networkResponse;
      } catch (_) {
        return new Response('', { status: 503 });
      }
    })());
    return;
  }

  event.respondWith((async () => {
    try {
      const preloadResponse = event.request.mode === 'navigate' ? await event.preloadResponse : null;
      if (preloadResponse) return preloadResponse;
      if (event.request.mode === 'navigate') {
        const navTimeout = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Navigation timeout')), 10000)
        );
        return await Promise.race([fetch(event.request, { cache: 'no-store' }), navTimeout]);
      }
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Fetch timeout')), 10000)
      );
      const networkResponse = await Promise.race([fetch(event.request), timeout]);

      if (networkResponse && networkResponse.status === 200 && shouldCacheRequest(event.request)) {
        try {
          const runtime = await caches.open(CACHE_RUNTIME);
          await runtime.put(event.request, networkResponse.clone());
          pruneRuntimeCache().catch(() => {});
        } catch (cacheErr) {
          // Falha em cache não deve quebrar a resposta
        }
      }
      return networkResponse;
    } catch (networkErr) {
      try {
        const cached = await caches.match(event.request);
        if (cached) return cached;
      } catch (_) {}

      if (event.request.mode === 'navigate') {
        try {
          const fallback = await caches.match('./offline.html');
          if (fallback) return fallback;
        } catch (_) {}
      }

      return new Response('', { status: 503 });
    }
  })());
});

self.addEventListener('sync', (event) => {
  if (event.tag === 'cysy-sync-pending') {
    event.waitUntil((async () => {
      const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
      clients.forEach((client) => client.postMessage({ type: 'SYNC_PENDING_REQUEST' }));
    })());
  }
});

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'cysy-periodic-sync') {
    event.waitUntil((async () => {
      await removeLegacyCaches();
      await pruneRuntimeCache();
      const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
      clients.forEach((client) => client.postMessage({ type: 'PERIODIC_SYNC_TICK' }));
    })());
  }
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'GET_SW_STATUS') {
    if (event.ports && event.ports[0]) {
      event.ports[0].postMessage({
        cacheName: CACHE_STATIC,
        runtimeCacheName: CACHE_RUNTIME,
        cacheVersion: CACHE_VERSION
      });
    }
    return;
  }

  if (event.data && event.data.type === 'CLEAR_OLD_CACHES') {
    event.waitUntil(
      removeLegacyCaches()
        .then(() => swLog('Old caches cleared', 'success'))
        .catch(err => swLog(`Error clearing old caches: ${err}`, 'error'))
    );
    return;
  }

  if (event.data && event.data.type === 'PRUNE_RUNTIME_CACHE') {
    event.waitUntil(
      pruneRuntimeCache()
        .then(() => swLog('Runtime cache pruned', 'success'))
        .catch(err => swLog(`Error pruning cache: ${err}`, 'error'))
    );
    return;
  }

  if (event.data && event.data.type === 'EMERGENCY_CLEAR_ALL_CACHES') {
    event.waitUntil(
      caches.keys()
        .then(keys => Promise.all(keys.map(key => caches.delete(key))))
        .then(() => {
          swLog('ALL caches cleared (emergency cleanup)', 'success');
          // Notificar o cliente para recarregar
          self.clients.matchAll().then(clients => {
            clients.forEach(client => {
              client.postMessage({ type: 'CACHE_EMERGENCY_CLEARED', reload: true });
            });
          });
        })
        .catch(err => swLog(`Error in emergency clear: ${err}`, 'error'))
    );
  }
});
