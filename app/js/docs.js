// 문서(= 저장된 데이터시트 한 장)의 구조와 순수 함수들. 화면/저장소와 무관해서 Node 에서도 시험할 수 있다.
//
// 문서에는 "입력값"만 저장한다. R₀, α, Fc 같은 계산 결과는 보여줄 때마다 calc.js 로 다시 구한다
// (계산 규칙을 고치면 저장된 문서에도 바로 반영되고, 입력값과 결과가 어긋날 일이 없다).
import { calculate, daysBetween } from './calc.js';

export const N = 20;
export const DOC_FORMAT = 'schmidt-datasheet';
export const DOC_VERSION = 1;

/* ───────── 사진대지 (현장 사진) ─────────
   문서에는 사진 목록(shots)만 저장하고 사진 본체(JPEG)는 별도 저장소에 둔다. 사진대지는 A4 한 쪽에 사진 2장. */
export const DEFAULT_WORK = '콘크리트 반발경도 확인';     // 사진대지 "시험내용" 기본값 (양식의 예시 문구)
export const MAX_SHOTS = 30;
export const SHOTS_PER_PAGE = 2;
export const photoPageCount = (n) => Math.ceil(n / SHOTS_PER_PAGE);
/** "2026-08-03" → "2026. 08. 03" (사진대지 양식의 날짜 표기) */
export const fmtDotDate = (s) => (s ? String(s).replaceAll('-', '. ') : '');
const SHOT_ID = /^[A-Za-z0-9_-]{1,40}$/;

/** 같은 기기에서 겹치지 않는 문서 번호 (crypto.randomUUID 는 http 주소에서 쓸 수 없어서 직접 만든다) */
export function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function blankDoc(over = {}) {
  const now = Date.now();
  return {
    id: newId(), v: DOC_VERSION, createdAt: now, updatedAt: now,
    testDate: todayStr(), pourDate: '', site: '', location: '', tester: '', supervisor: '',
    values: Array(N).fill(null), review: Array(N).fill(false),
    angle: 0, printedAverage: null, ageOverride: '', alphaOverride: '', order: 'row',
    photo: null,          // { rotation, boxes: { n: [x0,y0,x1,y1] (0~1) }, width, height }  — 사진 본체는 별도 저장소
    shots: [],            // 사진대지에 넣는 사진 [{ id, width, height }] — 본체는 별도 저장소
    workName: DEFAULT_WORK, shotFit: 'contain',   // 사진대지 시험내용 / 사진을 칸에 맞출지('contain') 채울지('cover')
    ...over,
  };
}

/** 문서 → 화면/양식이 쓰는 상태 (복사본) */
export function stateFromDoc(doc) {
  return {
    values: [...doc.values], review: [...(doc.review || Array(N).fill(false))],
    angle: doc.angle, printedAverage: doc.printedAverage,
    site: doc.site, location: doc.location, pourDate: doc.pourDate, testDate: doc.testDate,
    tester: doc.tester, supervisor: doc.supervisor,
    ageOverride: doc.ageOverride, alphaOverride: doc.alphaOverride, order: doc.order,
    shots: (doc.shots || []).map((x) => ({ ...x })), workName: doc.workName ?? DEFAULT_WORK, shotFit: doc.shotFit === 'cover' ? 'cover' : 'contain',
  };
}

/** 화면 상태 → 문서 (저장할 입력값만 골라 담는다) */
export function docFromState(s, base = {}) {
  return {
    ...blankDoc(), ...base,
    testDate: s.testDate || base.testDate || todayStr(),
    pourDate: s.pourDate || '', site: (s.site || '').trim(), location: (s.location || '').trim(),
    tester: (s.tester || '').trim(), supervisor: (s.supervisor || '').trim(),
    values: Array.from({ length: N }, (_, i) => (Number.isFinite(s.values[i]) ? s.values[i] : null)),
    review: Array.from({ length: N }, (_, i) => !!s.review?.[i]),
    angle: s.angle === null || s.angle === undefined ? null : s.angle,
    printedAverage: Number.isFinite(s.printedAverage) ? s.printedAverage : null,
    ageOverride: s.ageOverride ?? '', alphaOverride: s.alphaOverride ?? '', order: s.order === 'col' ? 'col' : 'row',
    shots: (s.shots || []).map(({ id, width, height }) => ({ id, width, height })),
    workName: (s.workName ?? DEFAULT_WORK).trim(), shotFit: s.shotFit === 'cover' ? 'cover' : 'contain',
  };
}

/** 계산 결과 (화면과 같은 규칙: 재령은 타설일~시험일, 직접 입력이 있으면 그것을 우선) */
export function calcFor(s) {
  const ageFromDates = daysBetween(s.pourDate, s.testDate);
  const ageDays = s.ageOverride !== '' && s.ageOverride !== null && s.ageOverride !== undefined ? Number(s.ageOverride) : ageFromDates;
  const alphaOverride = s.alphaOverride !== '' && s.alphaOverride !== null && s.alphaOverride !== undefined ? Number(s.alphaOverride) : null;
  const calc = calculate({ values: s.values, angle: s.angle ?? 0, ageDays, alphaOverride });
  calc.ageFromDates = ageFromDates;
  return calc;
}

/** 저장 여부 판단용 서명: 저장되는 입력값이 하나라도 바뀌면 달라진다 (updatedAt 같은 메타는 제외) */
export function docSignature(doc) {
  const { id, v, createdAt, updatedAt, ...rest } = doc;
  return JSON.stringify(rest);
}

/** 문서로 남길 가치가 있는가 (측정값이 하나라도 있거나 사진·사진대지 사진이 있을 때) */
export function hasContent(s, hasPhoto) {
  return !!hasPhoto || (s.shots?.length || 0) > 0 || s.values.some((v) => Number.isFinite(v));
}

/* ───────── 기록지 사진 ───────── */

export const PHOTO_MAX_SIDE = 2800;       // 문서함에 저장하는 사진의 긴 변 (px). 원본(4000px 이상)을 그대로 쌓으면 저장소가 금방 찬다

/** 긴 변이 max 를 넘지 않도록 줄인 크기 (이미 작으면 그대로) */
export function fitSize(w, h, max = PHOTO_MAX_SIDE) {
  const k = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

const r4 = (v) => Math.round(v * 10000) / 10000;       // 네 자리로 맞춰 두면 저장 → 열기 → 다시 정규화해도 값이 흔들리지 않는다

/** OCR 이 찾은 행 박스(회전된 이미지의 픽셀 좌표 {x0,y0,x1,y1}) → 0~1 로 정규화한 [x0,y0,x1,y1] */
export function normBoxes(rowBoxes, W, H) {
  const out = {};
  for (const [n, b] of Object.entries(rowBoxes || {})) out[n] = [r4(b.x0 / W), r4(b.y0 / H), r4(b.x1 / W), r4(b.y1 / H)];
  return out;
}

export function denormBoxes(boxes, W, H) {
  const out = {};
  for (const [n, b] of Object.entries(boxes || {})) out[n] = { x0: b[0] * W, y0: b[1] * H, x1: b[2] * W, y1: b[3] * H };
  return out;
}

/**
 * OCR 결과(readRecord)로 문서를 만든다 — 여러 장 한꺼번에 추가할 때 쓴다.
 * @param rec      readRecord 의 반환값
 * @param decoded  OCR 에 쓴 이미지 크기 { width, height } (회전 전). 박스 좌표가 이 크기를 기준으로 하므로 정규화에 쓴다
 * @param common   모든 문서에 공통으로 넣을 값 { testDate, site, tester, supervisor, pourDate, location }
 */
export function docFromRecord(rec, decoded, common = {}) {
  const swap = rec.rotation % 180 !== 0;
  const W = swap ? decoded.height : decoded.width, H = swap ? decoded.width : decoded.height;
  const values = Array(N).fill(null), review = Array(N).fill(false), rowBoxes = {};
  for (const r of rec.rows) {
    if (r.n < 1 || r.n > N) continue;
    values[r.n - 1] = r.value;
    review[r.n - 1] = !!r.review;
    if (r.box) rowBoxes[r.n] = r.box;
  }
  const stored = fitSize(decoded.width, decoded.height);
  return blankDoc({
    ...common, values, review,
    printedAverage: rec.average && Number.isFinite(rec.average.value) ? rec.average.value : null,
    angle: rec.angle === undefined ? null : rec.angle,
    photo: { rotation: rec.rotation || 0, width: stored.width, height: stored.height, boxes: normBoxes(rowBoxes, W, H) },
  });
}

/* ───────── 목록 표시용 ───────── */

export const titleOf = (doc) => doc.site || '(현장명 없음)';
export const subtitleOf = (doc) => [doc.location, doc.tester].filter(Boolean).join(' · ') || '시험위치·시험자 미입력';

/** 문서 한 건의 판정 표시들. kind: 'bad'(재시험) | 'warn'(확인 필요) */
export function statusFlags(doc, calc = calcFor(stateFromDoc(doc))) {
  const flags = [];
  const filled = doc.values.filter(Number.isFinite);
  if (calc.retest) flags.push({ kind: 'bad', text: '재시험' });
  else if (calc.Fc === null) flags.push({ kind: 'warn', text: calc.ageDays === null ? '타설일 필요' : '재령 확인' });
  if (doc.printedAverage !== null && filled.length) {
    const mean = filled.reduce((a, b) => a + b, 0) / filled.length;
    if (Math.abs(mean - doc.printedAverage) > 0.0501) flags.push({ kind: 'warn', text: '평균 불일치' });
  }
  if (filled.length && filled.length < N) flags.push({ kind: 'warn', text: `${filled.length}/${N}개` });
  if (!filled.length) flags.push({ kind: 'warn', text: '측정값 없음' });
  if (doc.angle === null) flags.push({ kind: 'warn', text: '각도 미확정' });
  return flags;
}

export function summaryOf(doc) {
  const calc = calcFor(stateFromDoc(doc));
  return { calc, flags: statusFlags(doc, calc), R0: calc.retest ? null : calc.R0, Fc: calc.retest ? null : calc.Fc };
}

const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
export function weekdayKo(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
  return m ? WEEK[new Date(+m[1], +m[2] - 1, +m[3]).getDay()] : '';
}

/** 시험일별로 묶는다: 날짜는 최근순, 같은 날 안에서는 만든 순서(= 시험한 순서) */
export function groupByDate(docs) {
  const map = new Map();
  for (const d of docs) {
    const key = d.testDate || '';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(d);
  }
  return [...map.entries()]
    .sort(([a], [b]) => (a === b ? 0 : a === '' ? 1 : b === '' ? -1 : a < b ? 1 : -1))
    .map(([date, list]) => ({ date, docs: list.sort((x, y) => x.createdAt - y.createdAt) }));
}

export function matches(doc, query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return true;
  return [doc.site, doc.location, doc.tester, doc.supervisor, doc.testDate].some((s) => (s || '').toLowerCase().includes(q));
}

/* ───────── 파일 이름 ───────── */

/** 파일/폴더 이름으로 쓸 수 없는 글자를 바꾸고 길이를 줄인다 */
export function safeName(s, max = 40) {
  return String(s || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, max)
    .trim();
}

/** 날짜별 순번(01, 02…)이 붙은 파일 기본 이름. 예) "01_테스트 현장 A동_3층 기둥 C5" */
export function fileBase(doc, indexInDay) {
  const nn = String(indexInDay + 1).padStart(2, '0');
  const parts = [safeName(doc.site) || '문서', safeName(doc.location)].filter(Boolean);
  return `${nn}_${parts.join('_')}`;
}

/** 내보내기 묶음 파일 이름. 예) "슈미트해머_2026-11-10_3건.zip" */
export function bundleName(docs) {
  const dates = [...new Set(docs.map((d) => d.testDate).filter(Boolean))].sort();
  const span = dates.length === 0 ? '' : dates.length === 1 ? dates[0] : `${dates[0]}~${dates[dates.length - 1]}`;
  return `슈미트해머_${span ? span + '_' : ''}${docs.length}건.zip`;
}

/* ───────── CSV 목록 ───────── */

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * 문서 목록(CSV). 엑셀에서 한글이 깨지지 않도록 UTF-8 BOM 을 붙인다.
 * @param {{doc:object, file?:string}[]} items  표시 순서대로
 */
export function toCsv(items) {
  const header = ['시험일', '번호', '현장명', '시험위치', '시험자', '감리원', '타설일', '재령(일)', '재령계수', '측정개수', '평균', '제외값', '타격각도', 'R0', 'Fc(MPa)', '판정', '파일'];
  const lines = [header.map(csvCell).join(',')];
  const perDay = new Map();
  for (const { doc, file } of items) {
    const n = (perDay.get(doc.testDate) || 0) + 1;
    perDay.set(doc.testDate, n);
    const { calc, flags } = summaryOf(doc);
    const filled = doc.values.filter(Number.isFinite);
    const judge = calc.retest ? '재시험' : flags.length ? flags.map((f) => f.text).join('; ') : '정상';
    lines.push([
      doc.testDate, n, doc.site, doc.location, doc.tester, doc.supervisor, doc.pourDate,
      calc.ageDays ?? '', calc.alpha === null ? '' : calc.alpha.toFixed(calc.alphaInterpolated ? 3 : 2),
      filled.length, filled.length ? (filled.reduce((a, b) => a + b, 0) / filled.length).toFixed(2) : '',
      calc.excluded || 0, doc.angle === null ? '' : doc.angle,
      calc.R0 === null || calc.retest ? '' : calc.R0.toFixed(1), calc.Fc === null || calc.retest ? '' : calc.Fc.toFixed(1),
      judge, file || '',
    ].map(csvCell).join(','));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/* ───────── 가져오기 검증 ───────── */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** 외부(가져온 파일)에서 온 문서를 믿지 않고 모양을 바로잡는다. 쓸 수 없으면 null */
export function sanitizeDoc(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id || raw.id.length > 80) return null;
  const values = Array.from({ length: N }, (_, i) => num(raw.values?.[i]));
  const date = (v) => (typeof v === 'string' && DATE_RE.test(v) ? v : '');
  let photo = null;
  if (raw.photo && typeof raw.photo === 'object') {
    const boxes = {};
    for (const [k, b] of Object.entries(raw.photo.boxes || {})) {
      const n = Number(k);
      if (Number.isInteger(n) && n >= 1 && n <= N && Array.isArray(b) && b.length === 4 && b.every((x) => typeof x === 'number' && Number.isFinite(x))) boxes[n] = b;
    }
    photo = { rotation: [0, 90, 180, 270].includes(raw.photo.rotation) ? raw.photo.rotation : 0, width: num(raw.photo.width) || 0, height: num(raw.photo.height) || 0, boxes };   // 키 순서는 저장 서명(docSignature)과 같게
  }
  const created = num(raw.createdAt) ?? Date.now();
  return {
    id: raw.id, v: DOC_VERSION, createdAt: created, updatedAt: num(raw.updatedAt) ?? created,
    testDate: date(raw.testDate), pourDate: date(raw.pourDate),
    site: str(raw.site, 60), location: str(raw.location, 120), tester: str(raw.tester, 40), supervisor: str(raw.supervisor, 40),
    values, review: Array.from({ length: N }, (_, i) => !!raw.review?.[i]),
    angle: raw.angle === null ? null : num(raw.angle), printedAverage: num(raw.printedAverage),
    ageOverride: typeof raw.ageOverride === 'string' || typeof raw.ageOverride === 'number' ? String(raw.ageOverride) : '',
    alphaOverride: typeof raw.alphaOverride === 'string' || typeof raw.alphaOverride === 'number' ? String(raw.alphaOverride) : '',
    order: raw.order === 'col' ? 'col' : 'row',
    photo,
    shots: (Array.isArray(raw.shots) ? raw.shots : [])
      .filter((x) => x && typeof x.id === 'string' && SHOT_ID.test(x.id))
      .slice(0, MAX_SHOTS).map((x) => ({ id: x.id, width: num(x.width) || 0, height: num(x.height) || 0 })),
    workName: typeof raw.workName === 'string' ? raw.workName.slice(0, 60) : DEFAULT_WORK,
    shotFit: raw.shotFit === 'cover' ? 'cover' : 'contain',
  };
}
