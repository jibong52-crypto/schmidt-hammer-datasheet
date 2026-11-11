import { buildStatic, renderSheet, fitSheet } from './sheet.js';
import { getEngine, decodeImage, drawRotated, engineInfo } from './ocr/loader.js';
import { readRecord } from './ocr/reader.js';
import { calcFor, docFromState, docSignature, hasContent, normBoxes, denormBoxes, fitSize, newId, stateFromDoc, DEFAULT_WORK, MAX_SHOTS, photoPageCount, SHOTS_PER_PAGE } from './docs.js';
import * as db from './store.js';
import { storedPhoto, shotImage } from './photo.js';
import { buildPhotoPage, fillPhotoPage, photoTexts } from './photosheet.js';
import { getSheetText, setSheetText } from './settings.js';
import { initPwa, isIOS } from './pwa.js';
import { renderDocPdf, pdfName } from './bundle.js';
import { initLibrary } from './library.js';
import { h, toast, deliverFile, fmtClock } from './ui.js';

const $ = (id) => document.getElementById(id);
const N = 20;

const state = {
  values: Array(N).fill(null),
  review: Array(N).fill(false),
  printedAverage: null,     // 기록지에 찍힌 AVERAGE
  angle: 0,                 // 타격 각도. 기록지에서 읽지 못하면 null (사용자가 고르기 전까지 계산은 0°로)
  site: '', location: '', pourDate: '', testDate: '', tester: '', supervisor: '',
  ageOverride: '', alphaOverride: '',
  order: 'row',
  ocrNotes: [],
  img: null,                // 디코딩된 원본 { data, width, height }
  rotation: 0,
  rowBoxes: {},             // n -> { x0,y0,x1,y1 } (회전된 이미지 좌표)
  rotSize: null,            // 회전된 이미지 크기
  shots: [],                // 사진대지 사진 [{ id, width, height }] (본체는 current.shotBlobs)
  workName: DEFAULT_WORK,   // 사진대지 시험내용
  shotFit: 'contain',       // 사진을 칸에 맞출지('contain') 채울지('cover')
};
let busy = false;
let lastCalc = null;
let library = null;           // 문서함 화면 (init 에서 만든다)

/* ───────── 문서 (문서함에 저장되는 한 장) ─────────
   작성 화면은 항상 "문서 한 장"을 편집한다. 측정값이 생기면 잠깐 뒤 자동으로 저장하고, 화면을 떠나거나 앱을 닫을 때도 저장한다.
   저장한 문서는 문서함(시험일별 목록)에서 다시 열 수 있다. 사진만 있고 측정값이 없는 문서는 [저장]을 눌러야 저장된다. */
const AUTOSAVE_MS = 1200;
const current = {
  id: newId(), createdAt: Date.now(),
  exists: false,          // 문서함에 이미 저장돼 있는가
  savedSig: '', savedAt: null,
  photoPromise: null,     // 저장용 사진(JPEG Blob)을 만드는 중이거나 만들어 둔 것
  photoDirty: false,      // 사진을 새로 불러왔는가 → 저장할 때 같이 쓴다
  photoMeta: null,        // 열려 있는 문서의 사진 정보 (사진이 아직 없거나 읽을 수 없을 때 그대로 유지)
  dropPhoto: false,       // 저장용 사진을 만들지 못해 사진 없이 저장하기로 한 경우
  shotBlobs: new Map(),   // 사진대지 사진 본체 id → Blob (저장된 것도 열 때 읽어 둔다)
  shotNew: new Set(),     // 아직 저장하지 않은 새 사진 id
  shotGone: new Set(),    // 저장돼 있었는데 지운 사진 id (다음 저장 때 저장소에서 지운다)
  sample: false,          // 예시 이미지 체험 중 → 자동 저장하지 않는다
  loading: false,         // 저장된 문서를 여는 중 → 저장하지 않는다
  error: '',
};
let autosaveTimer = 0;
let saveChain = Promise.resolve();
let docCount = 0;

function photoMeta() {
  if (current.dropPhoto) return null;
  if (state.img && state.rotSize) {
    const { width, height } = fitSize(state.img.width, state.img.height);          // 저장되는 사진의 크기
    return { rotation: state.rotation, width, height, boxes: normBoxes(state.rowBoxes, state.rotSize.width, state.rotSize.height) };
  }
  return current.photoMeta;
}
const currentDoc = () => docFromState(state, { id: current.id, createdAt: current.createdAt, photo: photoMeta() });
const hasValues = () => state.values.some(Number.isFinite);
const isDirty = () => !current.loading && docSignature(currentDoc()) !== current.savedSig;
const willAutosave = () => !current.loading && !current.sample && (current.exists || hasValues() || state.shots.length > 0);

function setTabCount(n) {
  docCount = n;
  const t = $('tabCount');
  t.textContent = String(n);
  t.hidden = n === 0;
}

function renderSaveState() {
  const el = $('saveState');
  let kind = 'new', text;
  if (current.loading) text = '문서를 여는 중…';
  else if (current.error) { kind = 'error'; text = current.error; }
  else if (current.sample) text = '예시 체험 중 · 자동 저장하지 않습니다';
  else if (!current.exists && !hasValues() && !state.img && !state.shots.length) text = '새 문서 · 측정값이 생기면 자동 저장됩니다';
  else if (isDirty()) { kind = 'dirty'; text = willAutosave() ? '저장 중…' : '저장되지 않음 · [저장]을 누르면 문서함에 넣습니다'; }
  else { kind = 'saved'; text = `문서함에 저장됨 · ${fmtClock(current.savedAt)}`; }
  el.dataset.state = kind;
  el.textContent = text;
}

function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  if (willAutosave() && isDirty()) autosaveTimer = setTimeout(() => saveNow({ auto: true }), AUTOSAVE_MS);
}

/** 화면을 다시 그린 뒤: 자동 저장 예약 + 저장 상태 표시 */
function afterRender() {
  scheduleAutosave();
  renderSaveState();
}

/** @returns {Promise<'saved'|'unchanged'|'empty'|'failed'>} */
function saveNow(opts = {}) {
  const run = saveChain.then(() => doSave(opts));
  saveChain = run.catch(() => {});
  return run;
}

async function doSave({ auto = false } = {}) {
  clearTimeout(autosaveTimer);
  if (current.loading) return 'unchanged';
  if (!auto) current.sample = false;                       // 예시라도 직접 [저장]을 누르면 문서로 남긴다
  const doc = currentDoc();
  if (!current.exists && !hasContent(state, !!doc.photo)) return 'empty';
  let sig = docSignature(doc);
  if (current.exists && sig === current.savedSig) return 'unchanged';

  const photoAtStart = current.photoPromise;
  let photoArg;                                            // undefined = 저장된 사진을 그대로 둔다
  if (current.photoDirty) {
    photoArg = photoAtStart ? await photoAtStart : null;
    if (photoArg === null) { current.dropPhoto = true; doc.photo = null; sig = docSignature(doc); }   // 저장용 사진을 만들지 못했다 → 사진 없이
  }
  doc.updatedAt = Date.now();
  const existed = current.exists;
  const newShotIds = [...current.shotNew], goneShotIds = [...current.shotGone];
  try {
    // 사진대지 사진: 새 사진은 문서보다 먼저(문서가 없는 사진을 가리키지 않도록), 지운 사진은 문서를 쓴 뒤에 정리한다
    for (const id of newShotIds) {
      const b = current.shotBlobs.get(id);
      if (b) await db.putShot(doc.id, id, b);
    }
    await db.putDoc(doc, photoArg);
    const stale = newShotIds.filter((id) => !doc.shots.some((s) => s.id === id));     // 저장하는 사이에 지운 새 사진
    await db.removeShots(doc.id, [...goneShotIds, ...stale]);
  } catch (e) {
    console.error(e);
    current.error = `저장하지 못했습니다 (${e?.message || e})`;
    renderSaveState();
    toast(current.error, 'bad', 7000);
    return 'failed';
  }
  current.error = '';
  current.exists = true;
  current.savedSig = sig;
  current.savedAt = doc.updatedAt;
  if (current.photoDirty && current.photoPromise === photoAtStart) current.photoDirty = false;   // 저장하는 사이 새 사진을 불러왔다면 그대로 남겨 둔다
  newShotIds.forEach((id) => current.shotNew.delete(id));
  goneShotIds.forEach((id) => current.shotGone.delete(id));
  if (!existed) { setTabCount(docCount + 1); db.requestPersistence(); }
  renderSaveState();
  return 'saved';
}

/** 저장할 변경이 있으면 지금 저장한다 (화면을 떠나기 전, 새 문서를 만들기 전, 앱이 가려질 때) */
async function flushSave() {
  clearTimeout(autosaveTimer);
  if (willAutosave() && isDirty()) await saveNow({ auto: true });
  else await saveChain;
}

function clearPreview() {
  $('previewWrap').hidden = true;
  $('overlay').textContent = '';
  setStatus('');
  setProgress(null);
  $('debugText').textContent = '';
  const c = $('previewCanvas');
  c.width = 1; c.height = 1;                                // 큰 비트맵 메모리를 돌려준다
}

/** 작성 화면을 새 문서로 비운다. 현장명·시험자·감리원은 그대로 (같은 날 같은 현장에서 이어서 쓰는 경우가 대부분) */
function resetEditor() {
  clearTimeout(autosaveTimer);
  Object.assign(state, {
    values: Array(N).fill(null), review: Array(N).fill(false), printedAverage: null, angle: 0,
    location: '', pourDate: '', testDate: today(), ageOverride: '', alphaOverride: '', order: 'row',
    ocrNotes: [], img: null, rotation: 0, rowBoxes: {}, rotSize: null,
    shots: [], workName: DEFAULT_WORK, shotFit: 'contain',
  });
  dropShotBlobs();
  Object.assign(current, {
    id: newId(), createdAt: Date.now(), exists: false, savedAt: null,
    photoPromise: null, photoDirty: false, photoMeta: null, dropPhoto: false, sample: false, loading: false, error: '',
  });
  clearPreview();
  syncFields();
  current.savedSig = docSignature(currentDoc());
  render();
}

async function newDocument() {
  await flushSave();
  resetEditor();
}

/** 문서함에서 문서를 열어 작성 화면에 불러온다 */
async function openDocument(id) {
  if (busy) { toast('사진을 읽는 중입니다. 끝난 뒤에 열어 주세요.'); return; }
  await flushSave();
  const doc = await db.getDoc(id);
  if (!doc) { toast('문서를 찾지 못했습니다.', 'bad'); library?.refresh(); return; }
  current.loading = true;
  clearPreview();
  Object.assign(state, stateFromDoc(doc), { ocrNotes: [], img: null, rotation: doc.photo?.rotation || 0, rowBoxes: {}, rotSize: null });
  dropShotBlobs();
  Object.assign(current, {
    id: doc.id, createdAt: doc.createdAt, exists: true, savedAt: doc.updatedAt,
    photoPromise: null, photoDirty: false, photoMeta: doc.photo || null, dropPhoto: false, sample: false, error: '',
  });
  // 사진대지 사진을 읽어 둔다 (저장소에 없는 사진은 목록에서 뺀다)
  const aliveShots = [];
  for (const s of state.shots) {
    const blob = await db.getShot(doc.id, s.id).catch(() => null);
    if (blob) { setShotBlob(s.id, blob); aliveShots.push(s); }
  }
  state.shots = aliveShots;
  syncFields();
  renderSaveState();
  if (doc.photo) {
    $('previewWrap').hidden = false;
    try {
      const blob = await db.getPhoto(doc.id);
      if (!blob) throw new Error('저장된 사진이 없습니다');
      state.img = await decodeImage(blob);
      current.photoPromise = Promise.resolve(blob);
      paintPreview();
      state.rowBoxes = denormBoxes(doc.photo.boxes, state.rotSize.width, state.rotSize.height);
      setStatus('저장된 기록지 사진입니다. 값을 고치거나, 방향이 다르면 회전한 뒤 [다시 인식]할 수 있습니다.');
    } catch (e) {
      console.error(e);
      state.img = null;
      setStatus('저장된 기록지 사진을 열 수 없습니다. 값은 그대로 편집할 수 있습니다.', 'warn');
    }
  }
  current.loading = false;
  current.savedSig = docSignature(currentDoc());
  render();
  refreshHighlight();
  if (location.hash === '#/edit') showView(); else location.hash = '#/edit';
  window.scrollTo(0, 0);
}

function showView() {
  const docs = location.hash.startsWith('#/docs');
  $('viewEditor').hidden = docs;
  $('viewLibrary').hidden = !docs;
  document.body.dataset.view = docs ? 'docs' : 'edit';
  $('tabEdit').setAttribute('aria-current', docs ? 'false' : 'page');
  $('tabDocs').setAttribute('aria-current', docs ? 'page' : 'false');
  if (docs) flushSave().then(() => library.refresh()).catch((e) => console.error(e));
  else requestAnimationFrame(fitSheet);
}

/* ───────── 입력값 기억 (이 기기의 localStorage) ─────────
   · 마지막으로 쓴 값: 현장명·시험위치·시험자·감리원 → 다음에 열 때 자동으로 채운다
   · 최근에 쓴 값 목록: 현장명·시험자·감리원 → 입력칸 아래 버튼(칩)으로 보여 주고 탭 한 번에 채운다
   폰·PC·앱은 저장소가 각각이라 서로 공유되지 않는다. */
const PROFILE_KEYS = ['site', 'location', 'tester', 'supervisor'];
const HISTORY_KEYS = ['site', 'tester', 'supervisor'];
const INPUT_ID = { site: 'f-site', location: 'f-location', tester: 'f-tester', supervisor: 'f-supervisor' };
const HISTORY_MAX = 8;       // 저장해 두는 최근 값 개수
const CHIPS_SHOWN = 5;       // 화면에 보여 주는 개수
const STORE_KEY = 'schmidt.profile.v2';
const OLD_STORE_KEY = 'schmidt.profile';      // 이전 버전(마지막 값만 저장)
const store = { last: {}, history: { site: [], tester: [], supervisor: [] }, ok: true };

function loadProfile() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      Object.assign(store.last, d.last || {});
      for (const k of HISTORY_KEYS) store.history[k] = Array.isArray(d.history?.[k]) ? d.history[k].filter((v) => typeof v === 'string' && v).slice(0, HISTORY_MAX) : [];
    } else {
      const old = localStorage.getItem(OLD_STORE_KEY);          // 이전 버전에서 저장한 값을 이어받는다
      if (old) { const d = JSON.parse(old); Object.assign(store.last, d); for (const k of HISTORY_KEYS) if (d[k]) store.history[k] = [d[k]]; }
    }
    localStorage.setItem('schmidt.probe', '1'); localStorage.removeItem('schmidt.probe');   // 실제로 쓸 수 있는지 확인
  } catch { store.ok = false; }                                  // 시크릿 모드 등 저장소가 막힌 환경
  for (const k of PROFILE_KEYS) if (typeof store.last[k] === 'string') state[k] = store.last[k];
}

function saveStore() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ last: store.last, history: store.history })); store.ok = true; } catch { store.ok = false; }
  renderRememberNote();
}

/** 입력하는 즉시 "마지막 값"으로 저장 (그대로 새로고침/종료해도 남도록) */
function remember(key) {
  if (!PROFILE_KEYS.includes(key)) return;
  store.last[key] = state[key];
  saveStore();
}

/** 입력을 마쳤을 때(포커스 이동·Enter·앱 전환) "최근 목록"의 맨 앞으로 올린다 — 타이핑 도중의 글자는 목록에 넣지 않는다 */
function commitHistory(key) {
  if (!HISTORY_KEYS.includes(key)) return;
  const v = (state[key] || '').trim();
  if (!v || store.history[key][0] === v) return;
  store.history[key] = [v, ...store.history[key].filter((x) => x !== v)].slice(0, HISTORY_MAX);
  saveStore();
  renderRecent(key);
}

function renderRecent(key) {
  const box = $(`recent-${key}`);
  if (!box) return;
  const current = (state[key] || '').trim();
  box.textContent = '';
  for (const v of store.history[key].filter((x) => x !== current).slice(0, CHIPS_SHOWN)) {
    const chip = document.createElement('span');
    chip.className = 'rc';
    const pick = document.createElement('button');
    pick.type = 'button'; pick.className = 'pick'; pick.textContent = v; pick.title = v;
    pick.addEventListener('click', () => fillField(key, v));
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'del'; del.textContent = '×'; del.setAttribute('aria-label', `${v} 목록에서 삭제`);
    del.addEventListener('click', () => { store.history[key] = store.history[key].filter((x) => x !== v); saveStore(); renderRecent(key); });
    chip.append(pick, del);
    box.appendChild(chip);
  }
}

function fillField(key, value) {
  const input = $(INPUT_ID[key]);
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));   // → 최근 목록 맨 앞으로
}

function renderRememberNote() {
  const n = $('rememberNote');
  if (!n) return;
  n.textContent = store.ok
    ? '현장명·시험위치·시험자·감리원은 이 기기에 기억해 두었다가 다음에 자동으로 채웁니다. 최근에 쓴 현장명·시험자·감리원은 입력칸 아래 버튼으로 바로 고를 수 있습니다.'
    : '이 브라우저에서는 입력값을 기억할 수 없습니다 (시크릿 모드이거나 저장소가 막혀 있습니다).';
  n.classList.toggle('warn-text', !store.ok);
}
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/* ───────── 측정값 입력칸 ───────── */
function buildValuesGrid() {
  const grid = $('valuesGrid');
  grid.textContent = '';
  for (let i = 0; i < N; i++) {
    const label = document.createElement('label');
    label.className = 'v';
    label.dataset.i = i;
    label.innerHTML = `<span>${String(i + 1).padStart(2, '0')}</span><input type="number" inputmode="numeric" min="0" max="120" step="1" aria-label="R${String(i + 1).padStart(2, '0')}" placeholder="–">`;
    const input = label.querySelector('input');
    input.addEventListener('input', () => {
      state.values[i] = input.value === '' ? null : Number(input.value);
      state.review[i] = false;
      render();
    });
    input.addEventListener('focus', () => highlightRow(i + 1));
    input.addEventListener('blur', () => highlightRow(null));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); grid.querySelectorAll('input')[Math.min(N - 1, i + 1)].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); grid.querySelectorAll('input')[Math.max(0, i - 1)].focus(); }
    });
    grid.appendChild(label);
  }
}

/* ───────── 렌더 ───────── */
const currentCalc = () => calcFor(state);       // 문서함 목록·PDF 와 같은 계산 규칙 (docs.js)

const fmt1 = (v) => (v === null || v === undefined ? '–' : v.toFixed(1));

function render() {
  const calc = (lastCalc = currentCalc());

  // 값 입력칸 상태 (포커스 중인 칸의 값은 덮어쓰지 않는다)
  $('valuesGrid').querySelectorAll('.v').forEach((lab) => {
    const i = Number(lab.dataset.i);
    const input = lab.querySelector('input');
    const v = state.values[i];
    if (document.activeElement !== input) input.value = Number.isFinite(v) ? String(v) : '';
    lab.classList.toggle('review', !!state.review[i] && !calc.flags?.[i]);
    lab.classList.toggle('excluded', !!calc.flags?.[i]);
  });

  // 각도
  $('angleSeg').querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(state.angle !== null && Number(b.dataset.angle) === state.angle)));
  $('angleSeg').classList.toggle('unset', state.angle === null);
  $('angleNote').textContent = state.angle === null
    ? '자동으로 읽지 못했습니다. 기록지의 ANGLE을 확인해 선택하세요 (지금은 0°로 계산).'
    : '';

  // 평균 검증
  const filled = state.values.filter((v) => Number.isFinite(v));
  const meanInput = filled.length ? filled.reduce((a, b) => a + b, 0) / filled.length : null;
  const avgMatch = state.printedAverage !== null && meanInput !== null ? Math.abs(meanInput - state.printedAverage) <= 0.0501 : null;
  const badge = $('verifyBadge');
  badge.hidden = avgMatch === null;
  if (avgMatch !== null) {
    badge.className = `badge ${avgMatch ? 'ok' : 'warn'}`;
    badge.textContent = avgMatch ? '기록지 평균과 일치' : '기록지 평균과 불일치';
  }

  // 통계
  const stats = [
    ['입력된 값', `${filled.length} / ${N}개`],
    ['입력값 평균', fmt1(meanInput)],
    ['기록지 AVERAGE', state.printedAverage === null ? '–' : fmt1(state.printedAverage)],
    ['제외값 (±20% 초과)', calc.excluded ? `${calc.excluded}개` : '없음'],
    ['타격각도 보정', calc.angleDelta ? `${calc.angleDelta > 0 ? '+' : '−'}${Math.abs(calc.angleDelta).toFixed(1)}` : '0'],
  ];
  $('stats').innerHTML = stats.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');

  // 메시지
  const msgs = [];
  for (const n of state.ocrNotes) msgs.push(['warn', n]);
  if (avgMatch === false) msgs.push(['warn', `입력값 평균(${fmt1(meanInput)})이 기록지 AVERAGE(${fmt1(state.printedAverage)})와 다릅니다. 기록지 원본과 대조하세요.`]);
  if (filled.length && filled.length < N) msgs.push(['warn', `측정값이 ${filled.length}개입니다 (기준 ${N}개).`]);
  if (!state.pourDate && filled.length) msgs.push(['info', '타설일을 입력하면 재령계수와 Fc가 계산됩니다.']);
  if (calc.ageDays !== null && calc.ageDays < 0) msgs.push(['bad', '시험일이 타설일보다 앞섭니다.']);
  const ageMissing = !state.pourDate && state.ageOverride === '';
  for (const w of calc.warnings) {
    if (w.startsWith('측정값이')) continue;                 // 위에서 이미 안내
    if (ageMissing && w.startsWith('재령일을 알 수')) continue;   // "타설일을 입력하면…" 안내와 중복
    msgs.push([calc.retest && w.includes('재시험') ? 'bad' : 'warn', w]);
  }
  $('messages').innerHTML = msgs.map(([k, t]) => `<li class="${k === 'info' ? '' : k}">${escapeHtml(t)}</li>`).join('');

  // 시험 정보: 자동값 안내
  const ageAuto = calc.ageFromDates;
  $('f-age').placeholder = ageAuto !== null && ageAuto >= 0 ? String(ageAuto) : '자동';
  $('ageAuto').textContent = state.ageOverride !== '' ? '(직접 입력)' : ageAuto !== null ? '(타설~시험 자동)' : '';
  const autoAlpha = calc.alpha !== null && !calc.alphaOverrideUsed ? calc.alpha.toFixed(calc.alphaInterpolated ? 3 : 2) : '';
  $('f-alpha').placeholder = autoAlpha || '표에서 자동';
  $('alphaAuto').textContent = calc.alphaOverrideUsed ? '(직접 입력)' : calc.alphaInterpolated ? '(표 보간)' : autoAlpha ? '(표에서 자동)' : '';

  // 요약 칩
  $('chipR0').textContent = calc.R0 === null || calc.retest ? '–' : calc.R0.toFixed(1);
  $('chipAlpha').textContent = calc.alpha === null || calc.retest ? '–' : calc.alpha.toFixed(calc.alphaInterpolated ? 3 : 2);
  $('chipFc').textContent = calc.retest ? '재시험' : calc.Fc === null ? '–' : calc.Fc.toFixed(1);

  renderSheet(state, calc);
  renderShots();
  afterRender();
}

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

/* ───────── 미리보기/하이라이트 ───────── */
function highlightRow(n) {
  const ov = $('overlay');
  ov.textContent = '';
  $('valuesGrid').querySelectorAll('.v').forEach((l) => l.classList.toggle('active', n !== null && Number(l.dataset.i) + 1 === n));
  const b = n !== null ? state.rowBoxes[n] : null;
  if (!b || !state.rotSize) return;
  const { width: W, height: H } = state.rotSize;
  const d = document.createElement('div');
  d.className = 'rb';
  Object.assign(d.style, { left: `${(b.x0 / W) * 100}%`, top: `${(b.y0 / H) * 100}%`, width: `${((b.x1 - b.x0) / W) * 100}%`, height: `${((b.y1 - b.y0) / H) * 100}%` });
  ov.appendChild(d);
  const box = $('previewBox'), inner = $('previewInner');
  const y = (b.y0 / H) * inner.clientHeight;
  box.scrollTo({ top: Math.max(0, y - box.clientHeight / 2 + 20), behavior: 'smooth' });
}

function paintPreview() {
  if (!state.img) return;
  state.rotSize = drawRotated($('previewCanvas'), state.img, state.rotation);
}

/** 인식 결과나 열린 문서가 바뀐 뒤: 포커스가 있는 입력칸의 행 하이라이트를 새 박스로 다시 그린다 */
function refreshHighlight() {
  const lab = document.activeElement?.closest?.('#valuesGrid .v');
  highlightRow(lab ? Number(lab.dataset.i) + 1 : null);
}

/* ───────── OCR ───────── */
function setEngine(stateName, text) {
  const e = $('engineStatus');
  e.dataset.state = stateName;
  e.textContent = text;
}
function setStatus(text, kind = '') {
  const s = $('ocrStatus');
  s.textContent = text;
  s.className = `status ${kind}`;
}
function setProgress(frac) {
  const p = $('progress');
  p.hidden = frac === null;
  if (frac !== null) $('progressBar').style.width = `${Math.round(frac * 100)}%`;
}
function setBusy(b) {
  busy = b;
  for (const id of ['btnRotL', 'btnRotR', 'btnRetry', 'btnSample', 'btnCamera']) $(id).disabled = b;
}

async function ensureEngine() {
  setEngine('loading', 'OCR 엔진 준비 중…');
  try {
    const eng = await getEngine((m) => setEngine('loading', `OCR 엔진 준비 중… ${m}`));
    setEngine('ready', 'OCR 엔진 준비됨');
    return eng;
  } catch (e) {
    console.error(e);
    setEngine('error', 'OCR 엔진 오류');
    throw e;
  }
}

async function runOcr(opts = {}) {
  if (busy || !state.img) return;
  setBusy(true);
  $('previewWrap').hidden = false;
  setProgress(0.05);
  setStatus('OCR 엔진 준비 중…');
  try {
    const engine = await ensureEngine();
    const t0 = performance.now();
    const rec = await readRecord(engine, state.img, {
      ...opts,
      onProgress: (msg, frac) => { setStatus(msg); setProgress(frac); },
    });
    applyRecord(rec, performance.now() - t0);
  } catch (e) {
    console.error(e);
    setStatus(`인식하지 못했습니다: ${e.message || e}. 측정값을 직접 입력해도 됩니다.`, 'bad');
  } finally {
    setProgress(null);
    setBusy(false);
  }
}

function applyRecord(rec, ms) {
  state.rotation = rec.rotation;
  paintPreview();

  if (!rec.valid) {
    // 기록지로 보이지 않으면 이미 입력된 값을 건드리지 않는다
    state.rowBoxes = {};
    setStatus('이 이미지에서 결과기록지(R 01, R 02 … AVERAGE)를 찾지 못했습니다. 기록지 전체가 보이게 다시 찍거나, 회전 버튼으로 방향을 맞춰 보세요. 측정값은 직접 입력해도 됩니다.', 'bad');
    $('debugText').textContent = '[읽은 줄]\n' + rec.lines.map((l) => `${l.text.padEnd(24)} ${l.conf.toFixed(2)}`).join('\n');
    render();
    return;
  }

  state.values = Array(N).fill(null);
  state.review = Array(N).fill(false);
  state.rowBoxes = {};
  let dropped = 0;
  for (const r of rec.rows) {
    if (r.n >= 1 && r.n <= N) {
      state.values[r.n - 1] = r.value;
      state.review[r.n - 1] = r.review;
      state.rowBoxes[r.n] = r.box;
    } else dropped++;
  }
  state.printedAverage = rec.average ? rec.average.value : null;
  state.angle = rec.angle;
  state.ocrNotes = rec.warnings.filter((w) => w.startsWith('행 번호') || w.startsWith('측정값 행') || w.startsWith('AVERAGE 줄'));
  if (dropped) state.ocrNotes.push(`${N}개를 넘는 ${dropped}개 행은 양식에 넣지 않았습니다.`);

  const sec = (ms / 1000).toFixed(1);
  const n = rec.count;
  if (!n) setStatus('측정값 행을 찾지 못했습니다. 사진이 기록지 전체를 담고 있는지, 회전 방향이 맞는지 확인하세요.', 'bad');
  else if (rec.avgMatch === true) setStatus(`${n}개 값을 읽었고 기록지의 AVERAGE와 일치합니다 (${sec}초)`, 'ok');
  else if (rec.avgMatch === false) setStatus(`${n}개 값을 읽었지만 기록지 AVERAGE와 일치하지 않습니다. 아래 값을 확인하세요 (${sec}초)`, 'warn');
  else setStatus(`${n}개 값을 읽었습니다. AVERAGE 줄을 읽지 못해 자동 검증은 못 했습니다 (${sec}초)`, 'warn');

  $('debugText').textContent =
    `엔진: 스레드 ${engineInfo.threads}개 / 추론 워커 ${engineInfo.proxy ? '사용' : '미사용(메인 스레드)'} / 교차출처 격리 ${engineInfo.isolated ? '예' : '아니오'}\n` +
    `채택: 회전 ${rec.rotation}° / ${rec.prep === 'norm' ? '조명 보정' : '원본 조명'} / 오른쪽 ${Math.round(rec.rightCrop * 100)}%${rec.roi ? ' / 기록지 영역 확대' : ''} (시도 ${rec.passes.length}회)\n` +
    `각도: ${rec.angle === null ? '미확정' : rec.angle + '° (' + (rec.angleSource === 'vote' ? '여러 변형 다수결' : '직접 인식') + ')'}\n` +
    rec.passes.map((p) => `  · ${p.prep === 'norm' ? '조명보정' : '원본'} 회전${p.rot}° 오른쪽${Math.round(p.right * 100)}% 임계값${p.bin}${p.roi ? ' 영역확대' : ''} → 행 ${p.count}개, 평균 ${p.avgMatch === null ? '?' : p.avgMatch ? '일치' : '불일치'}`).join('\n') +
    '\n\n[읽은 줄]\n' + rec.lines.map((l) => `${l.text.padEnd(24)} ${l.conf.toFixed(2)}`).join('\n');

  syncValues();
  render();
  refreshHighlight();
}

/* ───────── 이미지 입력 ───────── */
async function handleBlob(blob, { sample = false } = {}) {
  if (busy) { toast('사진을 읽는 중입니다. 끝난 뒤에 다시 선택하세요.'); return; }
  if (!blob || !blob.type.startsWith('image/')) { setStatus('이미지 파일을 선택하세요.', 'bad'); $('previewWrap').hidden = false; return; }
  $('previewWrap').hidden = false;
  setStatus('이미지 불러오는 중…');
  let img;
  try {
    img = await decodeImage(blob);
  } catch (e) {
    console.error(e);
    setStatus('이 이미지를 열 수 없습니다. JPG/PNG로 저장해서 다시 시도하세요 (HEIC는 일부 브라우저에서 열리지 않습니다).', 'bad');
    return;
  }
  // 저장된 문서를 보던 중이면 새 사진은 새 문서로 시작한다 (이전 문서가 덮어써지지 않도록)
  if (current.exists && hasValues()) {
    await newDocument();
    toast('새 문서로 시작합니다. 이전 문서는 문서함에 저장되어 있습니다.');
    $('previewWrap').hidden = false;
  }
  state.img = img;
  state.rotation = 0;
  current.sample = sample;
  current.photoDirty = true;
  current.dropPhoto = false;
  current.photoMeta = null;
  current.photoPromise = storedPhoto(img).catch((e) => { console.error(e); return null; });   // 문서함에 넣을 줄인 사진을 미리 만들어 둔다
  paintPreview();
  await runOcr();
}

async function loadSample() {
  const res = await fetch('samples/sample-record.jpg');
  await handleBlob(await res.blob(), { sample: true });
}

/* ───────── 이벤트 ───────── */
const FIELD_MAP = { 'f-site': 'site', 'f-location': 'location', 'f-pour': 'pourDate', 'f-test': 'testDate', 'f-tester': 'tester', 'f-supervisor': 'supervisor', 'f-age': 'ageOverride', 'f-alpha': 'alphaOverride', 'f-work': 'workName' };

/** 측정값 상태 → 입력칸 전체. render() 는 타이핑을 방해하지 않으려고 포커스가 있는 칸을 덮어쓰지 않으므로,
    문서를 바꾸거나 인식 결과를 적용할 때는 이 함수로 포커스 칸까지 맞춘다 */
function syncValues() {
  $('valuesGrid').querySelectorAll('input').forEach((inp, i) => { inp.value = Number.isFinite(state.values[i]) ? String(state.values[i]) : ''; });
}

/** 문서를 열거나 새로 시작할 때 상태 → 입력칸 (이벤트를 일으키지 않으므로 "마지막으로 쓴 값"을 건드리지 않는다) */
function syncFields() {
  for (const [id, key] of Object.entries(FIELD_MAP)) $(id).value = state[key] ?? '';
  syncValues();
  document.querySelectorAll('input[name="order"]').forEach((r) => { r.checked = r.value === state.order; });
  HISTORY_KEYS.forEach(renderRecent);
}

function bindFields() {
  for (const [id, key] of Object.entries(FIELD_MAP)) {
    const input = $(id);
    input.value = state[key] ?? '';
    input.addEventListener('input', () => {
      state[key] = input.value;
      remember(key);
      if (HISTORY_KEYS.includes(key)) renderRecent(key);
      render();
    });
    input.addEventListener('change', () => commitHistory(key));
    input.addEventListener('blur', () => commitHistory(key));
  }
  // 앱을 닫거나 다른 앱(카메라 등)으로 넘어갈 때, 입력 중이던 값도 최근 목록에 반영
  const commitAll = () => HISTORY_KEYS.forEach(commitHistory);
  window.addEventListener('pagehide', commitAll);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') commitAll(); });
  commitAll();                                  // 이전 버전에서 이어받은 마지막 값도 목록에 넣는다
  HISTORY_KEYS.forEach(renderRecent);
  renderRememberNote();
}

/** 파일을 어디로 보낼지: 한 장이면 작성 화면에서 바로 읽고, 여러 장이거나 ZIP/문서함 화면이면 문서함의 일괄 처리로 */
function routeFiles(files) {
  if (!files.length) return;
  const archive = files.some((f) => /\.(zip|json)$/i.test(f.name || ''));
  if (!archive && files.length === 1 && !location.hash.startsWith('#/docs')) return handleBlob(files[0]);
  return library.handleFiles(files);
}

function bindUpload() {
  const drop = $('drop'), file = $('fileInput'), cam = $('cameraInput');
  drop.addEventListener('click', () => file.click());
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); } });
  file.addEventListener('change', () => { const files = [...file.files]; file.value = ''; routeFiles(files); });
  cam.addEventListener('change', () => { if (cam.files[0]) handleBlob(cam.files[0]); cam.value = ''; });
  $('btnCamera').addEventListener('click', () => cam.click());
  $('btnSample').addEventListener('click', () => loadSample());

  // 끌어다 놓기: 창 어디에 놓아도 브라우저가 파일을 열어버리지 않게 막고, 이미지면 처리한다
  ['dragenter', 'dragover'].forEach((t) => window.addEventListener(t, (e) => { e.preventDefault(); if (e.dataTransfer?.types?.includes('Files')) drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => window.addEventListener(t, (e) => { if (t === 'drop' || e.target === document.documentElement || e.relatedTarget === null) drop.classList.remove('over'); }));
  window.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); routeFiles([...(e.dataTransfer?.files || [])]); });

  // 붙여넣기 (스크린샷/복사한 이미지)
  window.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (item) { e.preventDefault(); routeFiles([item.getAsFile()]); }
  });

  $('btnRotR').addEventListener('click', () => runOcr({ rotation: (state.rotation + 90) % 360 }));
  $('btnRotL').addEventListener('click', () => runOcr({ rotation: (state.rotation + 270) % 360 }));
  $('btnRetry').addEventListener('click', () => runOcr());
}

function bindAngle() {
  $('angleSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-angle]');
    if (!b) return;
    state.angle = Number(b.dataset.angle);
    render();
  });
  document.querySelectorAll('input[name="order"]').forEach((r) => r.addEventListener('change', () => { state.order = r.value; render(); }));
}

/** 안드로이드 앱(WebView)에서는 window.print() 가 동작하지 않아 앱이 노출한 인쇄 브리지를 쓴다 */
function printSheet() {
  const title = ['슈미트해머', state.site, state.testDate].filter(Boolean).join('_');
  if (window.AndroidBridge && typeof window.AndroidBridge.print === 'function') window.AndroidBridge.print(title);
  else window.print();
}

function bindPrint() {
  $('btnPrint').addEventListener('click', printSheet);
  let title;
  window.addEventListener('beforeprint', () => {
    title = document.title;
    const parts = ['슈미트해머', state.site, state.testDate].filter(Boolean);
    document.title = parts.join('_');
  });
  window.addEventListener('afterprint', () => { if (title) document.title = title; });
}

/* ───────── 사진대지 (현장 사진) ─────────
   4번 카드에서 사진을 넣으면 양식 미리보기 맨 뒤에 사진대지(A4 세로)가 붙는다. 사진 2장당 한 쪽.
   문서에는 사진 목록만 저장하고 사진 본체(긴 변 1600px JPEG)는 문서함 저장소에 따로 둔다. */
const shotUrls = new Map();       // 사진 id → 미리보기용 object URL
let shotKey = '';
let pageKey = '';

function setShotBlob(id, blob) {
  current.shotBlobs.set(id, blob);
  shotUrls.set(id, URL.createObjectURL(blob));
}

function dropShotBlobs() {
  for (const u of shotUrls.values()) URL.revokeObjectURL(u);
  shotUrls.clear();
  current.shotBlobs.clear(); current.shotNew.clear(); current.shotGone.clear();
}

async function addShots(files) {
  const list = [...files].filter((f) => (f.type ? f.type.startsWith('image/') : /\.(jpe?g|png|webp|bmp|gif|heic|heif)$/i.test(f.name || '')));
  if (!list.length) { toast('이미지 파일(JPG/PNG)을 선택하세요', 'bad'); return; }
  let added = 0, failed = 0;
  for (const f of list) {
    if (state.shots.length >= MAX_SHOTS) { toast(`사진대지 사진은 최대 ${MAX_SHOTS}장입니다`); break; }
    try {
      const { blob, width, height } = await shotImage(f);
      const id = newId();
      state.shots.push({ id, width, height });
      setShotBlob(id, blob);
      current.shotNew.add(id);
      added++;
    } catch (e) { console.error(e); failed++; }
  }
  if (failed) toast(`${failed}장은 열 수 없어 건너뛰었습니다 (JPG/PNG 로 저장해서 다시 시도하세요)`, 'bad', 5000);
  if (added) render();
}

function removeShot(id) {
  state.shots = state.shots.filter((s) => s.id !== id);
  if (current.shotNew.has(id)) current.shotNew.delete(id); else current.shotGone.add(id);   // 저장 전의 새 사진이면 그냥 버리고, 저장된 사진이면 다음 저장 때 저장소에서 지운다
  const u = shotUrls.get(id);
  if (u) URL.revokeObjectURL(u);
  shotUrls.delete(id);
  current.shotBlobs.delete(id);
  render();
}

function moveShot(i, d) {
  const j = i + d;
  if (j < 0 || j >= state.shots.length) return;
  [state.shots[i], state.shots[j]] = [state.shots[j], state.shots[i]];
  render();
}

function rebuildShotList() {
  const box = $('shotList');
  box.textContent = '';
  const last = state.shots.length - 1;
  state.shots.forEach((s, i) => {
    const label = `${Math.floor(i / SHOTS_PER_PAGE) + 1}쪽 사진-${(i % SHOTS_PER_PAGE) + 1}`;
    box.append(h('figure', { class: 'shot' },
      h('img', { src: shotUrls.get(s.id), alt: label }),
      h('figcaption', { text: label }),
      h('div', { class: 'shot-tools' },
        h('button', { type: 'button', title: '앞으로', 'aria-label': `${label} 앞으로`, text: '◀', disabled: i === 0, onClick: () => moveShot(i, -1) }),
        h('button', { type: 'button', title: '뒤로', 'aria-label': `${label} 뒤로`, text: '▶', disabled: i === last, onClick: () => moveShot(i, 1) }),
        h('button', { type: 'button', class: 'del', title: '삭제', 'aria-label': `${label} 삭제`, text: '✕', onClick: () => removeShot(s.id) }))));
  });
}

/** 양식 미리보기 맨 뒤의 사진대지 쪽: 사진 구성이 바뀔 때만 다시 만들고, 글은 매번 맞춘다 */
function renderPhotoPages(ids) {
  const host = $('sheetHost');
  const key = `${ids}|${state.shotFit}`;
  if (key !== pageKey) {
    pageKey = key;
    host.querySelectorAll('.page-frame.portrait').forEach((f) => f.remove());
    for (let p = 0; p < photoPageCount(state.shots.length); p++) {
      const frame = h('div', { class: 'page-frame portrait' });
      frame.append(buildPhotoPage());
      host.append(frame);
    }
  }
  const texts = photoTexts(state, getSheetText());
  host.querySelectorAll('.page-frame.portrait').forEach((frame, p) => {
    const group = state.shots.slice(p * SHOTS_PER_PAGE, (p + 1) * SHOTS_PER_PAGE);
    fillPhotoPage(frame.firstElementChild, texts, group.map((s) => ({ url: shotUrls.get(s.id) })), state.shotFit);
  });
}

function renderShots() {
  const ids = state.shots.map((s) => s.id).join(',');
  if (ids !== shotKey) { shotKey = ids; rebuildShotList(); }
  const n = state.shots.length;
  const badge = $('shotBadge');
  badge.hidden = n === 0;
  badge.textContent = `${n}장 · ${photoPageCount(n)}쪽`;
  $('fitSeg').querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.fit === state.shotFit)));
  renderPhotoPages(ids);
}

function bindShots() {
  const add = $('shotInput'), cam = $('shotCamera'), card = $('cardShots');
  $('btnShotAdd').addEventListener('click', () => add.click());
  $('btnShotCamera').addEventListener('click', () => cam.click());
  add.addEventListener('change', () => { const f = [...add.files]; add.value = ''; addShots(f); });
  cam.addEventListener('change', () => { const f = [...cam.files]; cam.value = ''; addShots(f); });
  card.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); addShots([...(e.dataTransfer?.files || [])]); });   // 이 카드에 놓은 사진은 기록지가 아니라 사진대지로
  $('fitSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-fit]');
    if (!b) return;
    state.shotFit = b.dataset.fit;
    render();
  });
  // 인쇄 머리글·바닥글: 이 기기에만 저장, 모든 문서에 적용 (회사 양식 문구는 코드에 넣지 않는다)
  const text = getSheetText();
  for (const [id, key] of [['f-head', 'head'], ['f-foot', 'foot']]) {
    const input = $(id);
    input.value = text[key];
    input.addEventListener('input', () => { setSheetText({ [key]: input.value }); render(); });
  }
  if (text.head || text.foot) $('sheetTextBox').open = true;
}

/** 문서함의 [사진으로 여러 장 추가]에서 쓴 현장명·시험자·감리원도 "마지막 값/최근 목록"에 반영한다 */
function rememberProfile(c) {
  for (const k of HISTORY_KEYS) {
    const v = (c[k] || '').trim();
    if (!v) continue;
    store.last[k] = v;
    store.history[k] = [v, ...store.history[k].filter((x) => x !== v)].slice(0, HISTORY_MAX);
  }
  saveStore();
  HISTORY_KEYS.forEach(renderRecent);
}

/** 지금 보고 있는 문서의 양식 2쪽을 PDF 파일로 저장 (앱에서는 저장/공유 선택) */
async function savePdf() {
  const btn = $('btnPdf');
  if (btn.disabled) return;
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'PDF 만드는 중…';
  try {
    const doc = currentDoc();
    const bytes = await renderDocPdf(doc, { getShot: async (id) => current.shotBlobs.get(id) || db.getShot(doc.id, id) });
    await deliverFile(new Blob([bytes], { type: 'application/pdf' }), pdfName(doc), 'application/pdf');
  } catch (e) {
    console.error(e);
    toast(`PDF 를 만들지 못했습니다: ${e?.message || e}`, 'bad', 7000);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

/** 작업 막대: 저장 / 새 문서 / PDF 저장 + 자동 저장 시점(화면을 떠날 때, 앱이 가려질 때) */
function bindDocActions() {
  $('btnSave').addEventListener('click', async () => {
    const r = await saveNow();
    if (r === 'saved') toast('문서함에 저장했습니다', 'ok');
    else if (r === 'unchanged') toast('이미 저장되어 있습니다');
    else if (r === 'empty') toast('저장할 내용이 없습니다. 사진을 불러오거나 측정값을 입력하세요.');
  });
  $('btnNew').addEventListener('click', async () => {
    if (busy) { toast('사진을 읽는 중입니다. 끝난 뒤에 눌러 주세요.'); return; }
    await newDocument();
    toast('새 문서를 시작합니다');
    window.scrollTo(0, 0);
    document.querySelector('.panel')?.scrollTo?.({ top: 0 });
  });
  $('btnPdf').addEventListener('click', savePdf);
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && !location.hash.startsWith('#/docs')) { e.preventDefault(); $('btnSave').click(); }
  });
  window.addEventListener('pagehide', () => { flushSave(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSave(); });
}

/* ───────── 시작 ───────── */
function init() {
  // 안드로이드 앱(APK)으로 실행 중이면 PC 전용 요소를 숨긴다 (UA 끝에 앱 이름이 붙어 있음)
  if (/SchmidtDatasheetApp/.test(navigator.userAgent)) document.documentElement.classList.add('in-app');
  // 터치 기기: 끌어다 놓기/붙여넣기 안내 대신 탭 안내
  if (window.matchMedia('(pointer: coarse)').matches) {
    $('dropMain').textContent = '탭해서 사진 선택';
    $('dropSub').textContent = '바로 찍으려면 아래 [카메라로 촬영]';
  }
  loadProfile();
  if (!state.testDate) state.testDate = today();
  buildStatic();
  buildValuesGrid();
  bindFields();
  bindUpload();
  bindAngle();
  bindPrint();
  bindDocActions();
  bindShots();

  fitSheet();
  new ResizeObserver(fitSheet).observe(document.querySelector('.preview'));
  current.savedSig = docSignature(currentDoc());          // 새 문서는 "저장할 변경이 없는" 상태에서 시작
  render();

  library = initLibrary({
    openDoc: openDocument,
    ensureEngine,
    getDefaults: () => ({ site: state.site, tester: state.tester, supervisor: state.supervisor }),
    rememberProfile,
    onDeleted: (ids) => { if (ids.includes(current.id)) resetEditor(); },    // 편집 중이던 문서를 문서함에서 지웠다
    onCount: setTabCount,
  });
  window.addEventListener('hashchange', showView);
  showView();
  library.refresh()
    .then(() => { if (!db.status.persistent) toast('이 브라우저에서는 문서를 저장해 둘 수 없어 이번 접속 동안만 유지됩니다.', 'bad', 8000); })
    .catch((e) => console.error(e));
  db.requestPersistence();

  // 아이폰(iOS)은 [인쇄]가 @page 용지 크기/방향(가로 양식 + 세로 사진대지)을 따르지 않아 제대로 나오지 않는다 → 숨기고,
  // [PDF 저장] 으로 만든 PDF 를 공유 시트의 [프린트]로 인쇄하게 한다
  if (isIOS()) { $('btnPrint').hidden = true; document.documentElement.classList.add('no-print-btn'); }
  // "휴대폰에서 열기"(같은 Wi-Fi QR 페이지)는 로컬 서버에서만 있다 — 인터넷에 배포된 주소에서는 숨긴다
  if (!/^(localhost|127\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(location.hostname)) $('phoneLink').hidden = true;

  if (location.protocol === 'file:') {
    $('fileNotice').hidden = false;
    setEngine('error', 'OCR 사용 불가 (file://)');
  } else {
    // 첫 인식이 빨라지도록 엔진을 미리 불러둔다
    setTimeout(() => ensureEngine().catch(() => {}), 400);
    initPwa();                                              // 서비스 워커(오프라인 실행) + 홈 화면 설치 안내
  }
}
init();
