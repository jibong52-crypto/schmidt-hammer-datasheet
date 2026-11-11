// 실행: node --test tests/native.test.mjs      (※ npm test 에 넣으려면 package.json 의 test 스크립트에 이 파일을 추가)
// 파일 공유(Web Share) 사용 조건 판정 (js/native.js 의 shareableFile / isStandalone).
// 브라우저 전역(window, navigator, matchMedia)을 시험마다 가짜로 바꿔 끼워 조건 조합을 확인한다.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis;                         // native.js 가 모듈이 불릴 때 window.__onNativeSave 를 단다
const { shareableFile, isStandalone, isTouch } = await import('../js/native.js');

const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

/** 환경을 흉내 낸다. coarse: (pointer: coarse) 여부, nav: navigator 에 덮어쓸 속성, standalone: (display-mode: standalone) 여부 */
function env({ coarse = true, standalone = false, nav = {}, media = true } = {}) {
  const base = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1' };
  Object.defineProperty(globalThis, 'navigator', { value: { ...base, ...nav }, configurable: true, writable: true });
  if (media) {
    globalThis.matchMedia = (q) => ({ matches: /pointer:\s*coarse/.test(q) ? coarse : /display-mode:\s*standalone/.test(q) ? standalone : false });
  } else {
    delete globalThis.matchMedia;
  }
}
const sharing = (canShare = () => true) => ({ share: async () => {}, canShare });
afterEach(() => {
  Object.defineProperty(globalThis, 'navigator', realNavigator);
  delete globalThis.matchMedia;
});

const pdf = () => new Blob([new Uint8Array(1234)], { type: 'application/pdf' });

test('공유: 터치 기기 + share/canShare 가 있고 canShare({files}) 가 true 면 File 을 돌려준다', () => {
  const seen = [];
  env({ nav: sharing((data) => { seen.push(data); return true; }) });
  const file = shareableFile(pdf(), '슈미트해머_테스트 현장_2026-11-10.pdf', 'application/pdf');
  assert.ok(file instanceof File);
  assert.equal(file.name, '슈미트해머_테스트 현장_2026-11-10.pdf');             // 한글 파일명 그대로
  assert.equal(file.type, 'application/pdf');
  assert.equal(file.size, 1234);
  assert.equal(seen.length, 1);
  assert.deepEqual(Object.keys(seen[0]), ['files']);                            // canShare 에도 files 만 물어본다
  assert.equal(seen[0].files.length, 1);
  assert.equal(seen[0].files[0], file);
});

test('공유: 이름·MIME 은 그대로 (ZIP)', () => {
  env({ nav: sharing() });
  const file = shareableFile(new Blob([new Uint8Array(10)]), '슈미트해머_2026-11-10_3건.zip', 'application/zip');
  assert.equal(file.name, '슈미트해머_2026-11-10_3건.zip');
  assert.equal(file.type, 'application/zip');
});

test('공유: 데스크톱(터치 아님)은 share 가 있어도 쓰지 않는다 → 바로 다운로드', () => {
  let asked = false;
  env({ coarse: false, nav: sharing(() => { asked = true; return true; }) });
  assert.equal(shareableFile(pdf(), 'a.pdf', 'application/pdf'), null);
  assert.equal(asked, false);                                                   // 터치 판정에서 이미 걸러서 canShare 도 부르지 않는다
});

test('공유: 안드로이드 앱(WebView)은 자체 저장 브리지가 있어 쓰지 않는다', () => {
  env({ nav: { ...sharing(), userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36 SchmidtDatasheetApp/1.0' } });
  assert.equal(shareableFile(pdf(), 'a.pdf', 'application/pdf'), null);
});

test('공유: canShare({files}) 가 false(예: 안드로이드 크롬의 ZIP)이면 쓰지 않는다', () => {
  env({ nav: sharing(() => false) });
  assert.equal(shareableFile(pdf(), 'a.pdf', 'application/pdf'), null);
});

test('공유: navigator.share 또는 canShare 가 없으면 쓰지 않는다 (예: 오래된 브라우저)', () => {
  env({ nav: { share: async () => {} } });
  assert.equal(shareableFile(pdf(), 'a.pdf', 'application/pdf'), null);
  env({ nav: { canShare: () => true } });
  assert.equal(shareableFile(pdf(), 'a.pdf', 'application/pdf'), null);
  env({ nav: {} });
  assert.equal(shareableFile(pdf(), 'a.pdf', 'application/pdf'), null);
});

test('공유: canShare 가 예외를 던져도 오류 없이 null (→ 다운로드로 대체)', () => {
  env({ nav: sharing(() => { throw new TypeError('Illegal invocation'); }) });
  assert.equal(shareableFile(pdf(), 'a.pdf', 'application/pdf'), null);
});

test('공유: matchMedia 가 없는 환경은 터치 기기가 아닌 것으로 본다', () => {
  env({ media: false, nav: sharing() });
  assert.equal(isTouch(), false);
  assert.equal(shareableFile(pdf(), 'a.pdf', 'application/pdf'), null);
});

test('홈 화면 설치 여부: display-mode: standalone 또는 iOS 의 navigator.standalone', () => {
  env({ standalone: false });
  assert.equal(isStandalone(), false);
  env({ standalone: true });
  assert.equal(isStandalone(), true);
  env({ standalone: false, nav: { standalone: true } });                        // 아이폰 Safari 의 홈 화면 앱
  assert.equal(isStandalone(), true);
  env({ standalone: false, nav: { standalone: false } });
  assert.equal(isStandalone(), false);
});
