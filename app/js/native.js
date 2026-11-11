// 파일 내보내기: 브라우저와 안드로이드 앱(WebView)의 방식이 달라서 한 곳에 모은다.
//  · 브라우저 : <a download> 로 내려받는다. 아이폰 같은 터치 기기에서 파일 공유(Web Share)를 쓸 수 있으면 공유 시트로 보낸다 (shareableFile, 화면은 ui.js 의 deliverFile).
//  · 앱       : WebView 는 blob 다운로드를 처리하지 못한다. 앱이 노출한 AndroidBridge 로 파일을 조각(base64)으로 넘기면
//               앱이 임시 파일로 받아 [기기에 저장](문서 만들기 화면에서 위치 선택) 또는 [공유](다른 앱으로 보내기)를 연다.
//               결과는 앱이 window.__onNativeSave(id, status, message) 로 알려 준다. status: ok | cancelled | error

export const inApp = () => /SchmidtDatasheetApp/.test(navigator.userAgent);

/** 이 앱 버전이 저장 브리지를 갖고 있는가 (옛 버전 앱이면 false) */
export const canSave = () => inApp() && typeof window.AndroidBridge?.saveBegin === 'function';

/** 터치 기기(폰·태블릿)인가? 마우스를 쓰는 데스크톱은 false */
export const isTouch = () => !!window.matchMedia?.('(pointer: coarse)').matches;

/** 홈 화면에 설치해서 앱처럼 열었는가 (아이폰은 navigator.standalone) */
export const isStandalone = () => !!window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;

/**
 * 파일을 공유 시트(Web Share)로 보낼 수 있으면 보낼 File 을, 아니면 null 을 돌려준다.
 *  · 아이폰 Safari / 홈 화면 앱은 blob 다운로드가 앱 화면을 PDF 뷰어로 바꿔 버려 돌아올 수 없으므로 공유 시트(파일 앱·카카오톡·메일)로 보낸다.
 *  · 안드로이드 앱(WebView)은 자체 저장 브리지가 있고, 데스크톱은 바로 내려받는 쪽이 낫다 → 해당 없음(null).
 * 이름·MIME 은 그대로 둔다 (한글 파일명 유지).
 */
export function shareableFile(blob, name, mime) {
  if (inApp() || !isTouch()) return null;
  if (typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') return null;
  try {
    const file = new File([blob], name, { type: mime });
    return navigator.canShare({ files: [file] }) ? file : null;
  } catch {
    return null;                                  // 이 브라우저는 파일 공유를 지원하지 않는다
  }
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

const CHUNK = 192 * 1024;                  // 한 번에 넘기는 크기 (base64 로는 256KB 안팎)
const pending = new Map();
let counter = 0;

window.__onNativeSave = (id, status, message) => {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  if (status === 'error') p.reject(new Error(message || '저장하지 못했습니다'));
  else p.resolve({ ok: status === 'ok', cancelled: status === 'cancelled', message: message || '' });
};

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * 앱으로 파일을 넘겨 저장/공유한다.
 * @param mode 'save' = 기기에 저장(위치 선택) | 'share' = 다른 앱으로 보내기
 * @returns {Promise<{ok:boolean, cancelled:boolean, message:string}>}
 */
export async function saveBlob(blob, name, mime, mode = 'save') {
  const bridge = window.AndroidBridge;
  const id = `j${Date.now().toString(36)}${++counter}`;
  const done = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  if (!bridge.saveBegin(id, name, mime || 'application/octet-stream', mode)) {
    pending.delete(id);
    throw new Error('앱이 파일을 받을 준비를 하지 못했습니다');
  }
  try {
    for (let off = 0; off < blob.size; off += CHUNK) {
      const bytes = new Uint8Array(await blob.slice(off, off + CHUNK).arrayBuffer());
      if (!bridge.saveChunk(id, toBase64(bytes))) throw new Error('앱으로 파일을 옮기는 중 오류가 났습니다 (저장 공간이 부족할 수 있습니다)');
    }
    bridge.saveFinish(id);
  } catch (e) {
    pending.delete(id);
    try { bridge.saveAbort(id); } catch { /* 이미 정리됨 */ }
    throw e;
  }
  return done;
}
