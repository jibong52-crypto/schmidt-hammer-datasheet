// 서비스 워커 — 앱 전체(OCR 모델 포함 약 30MB)를 처음 한 번 기기에 저장해 두고, 그다음부터는 인터넷 없이 실행한다.
//
// 배포할 때 tools/build-pwa.mjs 가 만드는 precache.js(버전 + 파일 목록)를 읽는다.
// precache.js 가 없으면(개발 중) 아무것도 캐시하지 않고 네트워크만 쓴다 → 파일을 고치면 바로 반영된다.
//
// 새 버전: 새 서비스 워커는 설치만 해 두고 기다린다(실행 중인 화면과 파일 버전이 섞이지 않도록).
//          화면이 알려 주면(pwa.js 의 [지금 적용]) SKIP_WAITING 을 받아 바로 교체한다.
let PRE = null;
try {
  importScripts('precache.js');
  PRE = self.PRECACHE || null;
} catch (e) {
  PRE = null;
}

const PREFIX = 'schmidt-';
const CACHE = PRE ? PREFIX + PRE.version : null;
const abs = (path) => new URL(path, self.registration.scope).href;

self.addEventListener('install', (event) => {
  if (!PRE) { self.skipWaiting(); return; }
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 큰 파일(모델·wasm)이 있어서 6개씩 나눠 받는다 (모바일 메모리·연결 보호)
    for (let i = 0; i < PRE.files.length; i += 6) {
      await Promise.all(PRE.files.slice(i, i + 6).map(async (file) => {
        const res = await fetch(new Request(abs(file), { cache: 'reload' }));
        if (!res.ok) throw new Error(`${file}: ${res.status}`);
        await cache.put(abs(file), res);
      }));
    }
    if (!self.registration.active) self.skipWaiting();       // 처음 설치면 이번 방문부터 바로 적용
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith(PREFIX) && key !== CACHE) await caches.delete(key);     // 이전 버전 정리
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  if (!CACHE) return;                                         // 개발 중: 브라우저 기본 동작
  const req = event.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(respond(req));
});

async function respond(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req, { ignoreSearch: true }); // ?workers=0 같은 검색어가 붙어도 같은 파일
  if (hit) return hit;
  try {
    return await fetch(req);
  } catch (e) {
    if (req.mode === 'navigate') {                            // 인터넷 없이 주소를 직접 열어도 앱 화면
      const home = (await cache.match(abs('index.html'))) || (await cache.match(abs('./')));
      if (home) return home;
    }
    return Response.error();
  }
}
