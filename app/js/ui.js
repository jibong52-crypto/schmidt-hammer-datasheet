// 화면 공통 도우미: 작은 DOM 생성기, 알림(토스트), 대화상자, 파일 내보내기 안내.
import { inApp, canSave, saveBlob, downloadBlob, shareableFile, isStandalone } from './native.js';

/** 아주 작은 DOM 생성기: h('div', { class: 'x', onClick: fn }, 자식…) */
export function h(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.length > 2 && k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (typeof v !== 'object' && k in e && k !== 'list' && !k.includes('-')) e[k] = v;
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(2)) {
    if (c === null || c === undefined || c === false) continue;
    e.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return e;
}

export const fmtSize = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(bytes / 1024))}KB`);
export const fmtClock = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

/* ───────── 토스트 ───────── */

let toasts = null;
export function toast(message, kind = '', ms = 3500) {
  if (!toasts) {
    toasts = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toasts);
  }
  const t = h('div', { class: `toast ${kind}`, text: message });
  toasts.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms);
}

/* ───────── 대화상자 ───────── */

const stack = [];
let seq = 0;

/**
 * @param {object} o
 * @param {string} [o.title]
 * @param {Node|string|Array} [o.body]
 * @param {{label:string, value?:any, kind?:string, keepOpen?:boolean, disabled?:boolean, onClick?:(api)=>any}[]} [o.actions]
 *        버튼을 누르면 value 로 닫힌다. onClick 이 false 를 돌려주면 닫지 않는다.
 * @param {boolean} [o.dismissable=true]  Esc / 뒤로 가기로 닫을 수 있는가 (닫으면 결과는 null)
 * @returns {{el, bodyEl, actionsEl, result:Promise<any>, close:(v?:any)=>void, setActions:(list)=>void}}
 */
export function dialog({ title = '', body = null, actions = [], dismissable = true, wide = false } = {}) {
  const titleId = `dlg-title-${++seq}`;
  const bodyEl = h('div', { class: 'dlg-body' }, body);
  const actionsEl = h('div', { class: 'dlg-actions' });
  const el = h('dialog', { class: `dlg${wide ? ' wide' : ''}`, 'aria-labelledby': title ? titleId : null },
    h('div', { class: 'dlg-inner' }, title && h('h3', { id: titleId, text: title }), bodyEl, actionsEl));
  let settle;
  const result = new Promise((r) => { settle = r; });
  const api = { el, bodyEl, actionsEl, result, closed: false, dismissable, close, setActions };

  function close(value = null) {
    if (api.closed) return;
    api.closed = true;
    const i = stack.indexOf(api);
    if (i >= 0) stack.splice(i, 1);
    try { el.close(); } catch { /* 이미 닫힘 */ }
    el.remove();
    settle(value);
  }

  function setActions(list) {
    actionsEl.textContent = '';
    for (const a of list) {
      const b = h('button', { type: 'button', class: `btn ${a.kind || ''}`, text: a.label, disabled: !!a.disabled });
      b.addEventListener('click', async () => {
        if (a.onClick) {
          b.disabled = true;
          const r = await a.onClick(api);
          if (!api.closed) b.disabled = !!a.disabled;
          if (r === false) return;
        }
        if (!a.keepOpen) close(a.value === undefined ? a.label : a.value);
      });
      actionsEl.append(b);
    }
  }

  setActions(actions);
  el.addEventListener('cancel', (e) => { e.preventDefault(); if (api.dismissable) close(null); });
  document.body.append(el);
  el.showModal();
  stack.push(api);
  return api;
}

export async function confirmDialog({ title, message, ok = '확인', cancel = '취소', danger = false }) {
  const d = dialog({
    title, body: h('p', { class: 'dlg-text', text: message }),
    actions: [{ label: cancel, value: false }, { label: ok, value: true, kind: danger ? 'danger' : 'primary' }],
  });
  return (await d.result) === true;
}

/** 여러 선택지 중 하나를 고르게 한다. 닫으면 null */
export function choiceDialog({ title, message, choices, cancel = '닫기' }) {
  const d = dialog({
    title, body: h('p', { class: 'dlg-text', text: message }),
    actions: [{ label: cancel, value: null }, ...choices.map((c) => ({ label: c.label, value: c.value, kind: c.kind || '' }))],
  });
  return d.result;
}

/** 진행 막대 대화상자. d.update(비율 0~1, 문구, 보조문구) / d.close() */
export function progressDialog({ title, onCancel = null, cancelLabel = '중단' } = {}) {
  const fill = h('i');
  const text = h('p', { class: 'dlg-text' });
  const sub = h('p', { class: 'dlg-sub' });
  const d = dialog({
    title, body: [h('div', { class: 'pbar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100 }, fill), text, sub],
    dismissable: false,
    actions: onCancel ? [{
      label: cancelLabel, keepOpen: true,
      onClick: (api) => {
        onCancel();
        const b = api.actionsEl.querySelector('button');
        if (b) { b.textContent = '중단하는 중…'; b.disabled = true; }
        return false;
      },
    }] : [],
  });
  d.update = (frac, t = '', s = '') => {
    const pct = Math.max(0, Math.min(100, Math.round(frac * 100)));
    fill.style.width = `${pct}%`;
    fill.parentElement.setAttribute('aria-valuenow', String(pct));
    text.textContent = t;
    sub.textContent = s;
  };
  d.update(0);
  return d;
}

/* ───────── 뒤로 가기 (안드로이드 앱이 호출) ───────── */

const backHandlers = [];
/** 화면이 자체적으로 처리할 "뒤로" 동작을 등록한다 (선택 해제 등). 처리했으면 true 를 돌려준다 */
export function onBack(fn) { backHandlers.push(fn); }

/** 앱의 뒤로 가기 버튼 → 맨 위 대화상자를 닫고, 없으면 등록된 처리기, 그것도 없으면 false(= 앱이 화면 기록/종료를 처리) */
window.__onBack = () => {
  const top = stack[stack.length - 1];
  if (top) { if (top.dismissable) top.close(null); return true; }
  return backHandlers.some((fn) => fn());
};

/* ───────── 파일 내보내기 ───────── */

/**
 * 만든 파일을 사용자에게 건넨다.
 *  · 데스크톱 브라우저: 바로 내려받기
 *  · 아이폰 등 터치 기기의 브라우저/홈 화면 앱(파일 공유를 지원할 때): [다운로드] / [공유] 를 고르게 한다
 *    (blob 다운로드는 앱 화면을 PDF 뷰어로 바꿔 버리므로 공유 시트로 파일 앱·카카오톡·메일에 보내는 쪽이 맞다)
 *  · 안드로이드 앱: [기기에 저장] / [공유] 를 고르게 한다
 * @returns {Promise<{ok?:boolean, cancelled?:boolean}>}
 */
export async function deliverFile(blob, name, mime = blob.type || 'application/octet-stream') {
  if (!inApp() || !canSave()) {
    const file = shareableFile(blob, name, mime);
    if (file) return deliverByShareSheet(blob, name, file);
    downloadBlob(blob, name);
    toast(`내려받기를 시작했습니다: ${name}`, 'ok');
    return { ok: true };
  }
  const mode = await choiceDialog({
    title: '파일을 만들었습니다',
    message: `${name}\n${fmtSize(blob.size)}\n\n어떻게 내보낼까요?`,
    choices: [{ label: '다른 앱으로 공유', value: 'share' }, { label: '기기에 저장', value: 'save', kind: 'primary' }],
    cancel: '닫기',
  });
  if (!mode) return { cancelled: true };
  try {
    const r = await saveBlob(blob, name, mime, mode);
    if (r.cancelled) toast('저장을 취소했습니다');
    else toast(mode === 'share' ? '공유 화면을 열었습니다' : `저장했습니다${r.message ? `: ${r.message}` : ''}`, 'ok');
    return r;
  } catch (e) {
    toast(`저장하지 못했습니다: ${e.message || e}`, 'bad', 7000);
    throw e;
  }
}

/**
 * 파일 공유(Web Share) 선택창: [닫기] [다운로드] [공유].
 * 파일을 만드는 데 시간이 걸려서 처음 누른 버튼의 사용자 제스처는 이미 끝났다. 그래서 만든 뒤에 이 창을 띄우고,
 * [공유] 를 누르는 그 클릭 안에서 navigator.share 를 부른다 (Safari 는 제스처가 끊기면 NotAllowedError).
 * 공유 시트만 닫은 경우(AbortError)는 취소이므로 오류로 알리지 않고 선택창을 그대로 둔다. 다른 오류는 알리고 [다운로드]로 받을 수 있게 한다.
 */
async function deliverByShareSheet(blob, name, file) {
  const err = h('p', { class: 'dlg-error', role: 'alert', hidden: true });
  const d = dialog({
    title: '파일을 만들었습니다',
    body: [
      h('p', { class: 'dlg-text', text: `${name}\n${fmtSize(blob.size)}\n\n어떻게 내보낼까요?` }),
      isStandalone() && h('p', { class: 'hint', text: '홈 화면에 설치한 앱에서 [다운로드]를 누르면 앱 화면이 파일 보기로 바뀌어 돌아오기 어려울 수 있습니다. 보통은 [공유]를 쓰세요.' }),
      err,
    ],
    actions: [
      { label: '닫기', value: null },
      { label: '다운로드', value: 'download' },
      // dialog() 가 클릭 핸들러에서 onClick 을 바로(동기) 부른다 → 앞에 await 없이 share 를 호출할 수 있다
      { label: '공유', value: 'share', kind: 'primary', onClick: () => shareFromDialog(file, err) },
    ],
  });
  const mode = await d.result;
  if (mode === 'share') { toast(`내보냈습니다: ${name}`, 'ok'); return { ok: true }; }
  if (mode === 'download') {
    downloadBlob(blob, name);
    toast(`내려받기를 시작했습니다: ${name}`, 'ok');
    return { ok: true };
  }
  return { cancelled: true };
}

/**
 * [공유] 단추의 동작. navigator.share 를 이 함수 안에서 바로(동기) 부르고, 창을 닫을지(true) 그대로 둘지(false)를 Promise 로 돌려준다.
 *  · 공유 완료 → true (창을 닫는다)
 *  · 공유 시트를 닫음(AbortError) → false, 아무 알림 없이 선택창으로 돌아온다
 *  · 그 밖의 오류 → 알리고 false (선택창이 남아 있어 [다운로드]로 받을 수 있다)
 */
function shareFromDialog(file, errEl) {
  errEl.hidden = true;
  let sharing;
  try { sharing = Promise.resolve(navigator.share({ files: [file] })); } catch (e) { sharing = Promise.reject(e); }
  return sharing.then(() => true, (e) => {
    if (e?.name === 'AbortError') return false;
    console.error(e);
    // 토스트는 모달 창의 어두운 배경 아래에 깔려 흐리게 보이므로, 창 안에도 같은 안내를 적는다
    const msg = `공유하지 못했습니다 (${e?.name || '오류'}). [다운로드]로 받아 보세요.`;
    errEl.textContent = msg;
    errEl.hidden = false;
    toast(msg, 'bad', 7000);
    return false;
  });
}
