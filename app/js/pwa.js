// PWA: 서비스 워커 등록(오프라인 실행), 새 버전 알림, 홈 화면 설치 안내.
//  · 아이폰 Safari 는 "설치" 버튼이 없어서 공유 버튼 → [홈 화면에 추가]를 안내 문구로 알려 준다.
//  · 카카오톡·네이버 같은 앱 안의 브라우저에서는 홈 화면에 추가할 수 없어서 Safari 로 열도록 안내한다.
//  · 안드로이드 앱(APK)은 이미 앱 안에 모든 것이 들어 있어서 아무것도 하지 않는다.
import { h, toast } from './ui.js';

const KEY = 'schmidt.pwa.v1';
const HIDE_DAYS = 14;                                         // 안내를 닫으면 이 기간 동안 다시 보이지 않는다
const $ = (id) => document.getElementById(id);

const inApk = () => /SchmidtDatasheetApp/.test(navigator.userAgent);
const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
export const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isTouch = () => window.matchMedia('(pointer: coarse)').matches;
/** 앱 안의 브라우저 (홈 화면 추가 불가) */
const inAppBrowser = () => /KAKAOTALK|NAVER\(inapp|Instagram|FBAN|FBAV|FB_IAB|Line\/|DaumApps|Snapchat|MicroMessenger/i.test(navigator.userAgent);

function hidden() {
  try { const t = JSON.parse(localStorage.getItem(KEY) || '{}').dismissedAt; return !!t && Date.now() - t < HIDE_DAYS * 864e5; } catch { return false; }
}
function dismiss() {
  try { localStorage.setItem(KEY, JSON.stringify({ dismissedAt: Date.now() })); } catch { /* 저장소가 막힌 환경 */ }
  const bar = $('pwaBar');
  if (bar) bar.hidden = true;
}

function showBar(message, ...actions) {
  const bar = $('pwaBar');
  if (!bar) return;
  bar.textContent = '';
  bar.append(h('p', { text: message }), ...actions,
    h('button', { type: 'button', class: 'btn small ghost', text: '닫기', onClick: dismiss }));
  bar.hidden = false;
}

/** 새 버전이 준비되면 알린다. [지금 적용]을 누르면 대기 중인 서비스 워커로 교체하고 다시 불러온다 */
function offerUpdate(worker) {
  const bar = $('pwaBar');
  if (!bar) return;
  bar.textContent = '';
  bar.append(
    h('p', { text: '새 버전이 준비되었습니다.' }),
    h('button', { type: 'button', class: 'btn small primary', text: '지금 적용', onClick: () => worker.postMessage('SKIP_WAITING') }),
    h('button', { type: 'button', class: 'btn small ghost', text: '나중에', onClick: () => { bar.hidden = true; } }));
  bar.hidden = false;
}

async function registerWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (!(location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) return;   // 서비스 워커는 보안 연결에서만
  let reloading = false;
  const hadController = !!navigator.serviceWorker.controller;    // 이 페이지가 열릴 때 이미 서비스 워커의 관리 아래였나 (첫 방문이면 false → "새 버전"이 아니다)
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading || !sessionStorage.getItem('schmidt.sw.update')) return;           // 새 버전을 직접 적용한 경우에만 다시 불러온다 (첫 설치로 인한 교체는 무시)
    reloading = true;
    sessionStorage.removeItem('schmidt.sw.update');
    location.reload();
  });
  try {
    const reg = await navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' });
    const watch = (worker) => {
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && hadController) {    // 이미 실행 중인 버전이 있을 때만 "새 버전" (첫 설치는 해당 없음)
          sessionStorage.setItem('schmidt.sw.update', '1');
          offerUpdate(worker);
        }
      });
    };
    if (reg.waiting && hadController) { sessionStorage.setItem('schmidt.sw.update', '1'); offerUpdate(reg.waiting); }
    if (reg.installing) watch(reg.installing);
    reg.addEventListener('updatefound', () => reg.installing && watch(reg.installing));
    // 앱을 다시 열 때마다(백그라운드에서 돌아올 때) 새 버전이 있는지 확인
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  } catch (e) {
    console.warn('서비스 워커를 등록하지 못했습니다 (오프라인 실행은 쓸 수 없지만 앱은 정상 동작합니다)', e);
  }
}

/** 홈 화면 설치 안내 */
function installHint() {
  if (standalone() || hidden() || !isTouch()) return;
  const copy = h('button', {
    type: 'button', class: 'btn small', text: '주소 복사',
    onClick: async () => { try { await navigator.clipboard.writeText(location.href); toast('주소를 복사했습니다. Safari 에 붙여 넣어 여세요.', 'ok'); } catch { toast(location.href, '', 8000); } },
  });
  if (inAppBrowser()) {
    showBar(isIOS()
      ? '지금은 앱 안의 브라우저라 홈 화면에 설치할 수 없습니다. 화면 오른쪽 아래 ⋯ 를 눌러 [Safari로 열기]를 선택하세요.'
      : '지금은 앱 안의 브라우저라 설치할 수 없습니다. 메뉴(⋮)에서 [다른 브라우저로 열기]를 선택하세요.', copy);
    return;
  }
  if (isIOS()) {
    showBar('홈 화면에 추가하면 앱처럼 쓰고 인터넷이 없어도 실행되며, 저장한 문서가 Safari 의 자동 정리(오래 안 열면 삭제)에서 빠집니다. Safari 아래쪽 공유 버튼(□↑)을 누르고 [홈 화면에 추가]를 선택하세요.');
    return;
  }
  window.addEventListener('beforeinstallprompt', (e) => {      // 안드로이드 크롬 등
    e.preventDefault();
    showBar('앱으로 설치하면 인터넷이 없어도 실행됩니다.',
      h('button', { type: 'button', class: 'btn small primary', text: '설치', onClick: async () => { $('pwaBar').hidden = true; e.prompt(); } }));
  });
}

export function initPwa() {
  if (inApk()) return;
  registerWorker();
  installHint();
}
