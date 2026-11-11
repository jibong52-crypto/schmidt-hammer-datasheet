// 양식(데이터시트)을 그리고 값을 채운다.
//
// 모든 함수는 root(기본: 화면의 document)를 받는다. 문서를 PDF 로 내보낼 때는 화면의 양식을 복제한 요소를 root 로 넘겨,
// 화면에 열려 있는 문서를 건드리지 않고 다른 문서의 양식을 그린다.
import { AGE_TABLE, ANGLE_TABLE, ANGLE_COLUMNS } from './tables.js';

const NS = 'http://www.w3.org/2000/svg';
// 타점 격자. 원의 중심 사이 간격은 가로·세로 모두 3cm 로 인쇄된다.
// 인쇄/PDF 에서는 양식(1342×926px)을 A4 가로(여백 8mm)에 맞춰 0.79배로 줄이므로 양식 1px = 0.209mm → 30mm ÷ 0.209 = 143.5px.
// (이 값을 바꾸면 인쇄 배율도 함께 확인할 것: css/app.css 의 @media print `--k`, js/pdf.js 의 맞춤 배율)
export const GRID = { cols: 5, rows: 4, x0: 77, dx: 143.5, y0: 80, dy: 143.5, r: 28, padLeft: 37, padRight: 39 };
const el = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
};

/** 값과 무관한 정적 부분(타점 격자, 참고표)을 한 번만 만든다 */
export function buildStatic(root = document) {
  const svg = root.querySelector('#gridSvg');
  svg.textContent = '';
  const xs = Array.from({ length: GRID.cols }, (_, c) => GRID.x0 + c * GRID.dx);
  const ys = Array.from({ length: GRID.rows }, (_, r) => GRID.y0 + r * GRID.dy);
  // 격자선 (양식과 같이 왼쪽/오른쪽으로 조금 더 뻗어 있다)
  ys.forEach((y) => el('line', { class: 'g', x1: GRID.x0 - GRID.padLeft, y1: y, x2: xs[xs.length - 1] + GRID.padRight, y2: y }, svg));
  xs.forEach((x) => el('line', { class: 'g', x1: x, y1: ys[0], x2: x, y2: ys[ys.length - 1] }, svg));

  ys.forEach((y, r) => xs.forEach((x, c) => {
    const g = el('g', { 'data-r': r, 'data-c': c }, svg);
    el('circle', { class: 'c', cx: x, cy: y, r: GRID.r }, g);
    el('text', { class: 'r', x, y: y + 1 }, g);
    el('line', { class: 'slash', x1: x - 19, y1: y + 19, x2: x + 19, y2: y - 19, visibility: 'hidden' }, g);
    el('text', { class: 'i', x: x - GRID.r - 4, y: y - GRID.r + 6, 'text-anchor': 'end' }, g);
  }));

  // 재령보정계수표 (3단)
  const host = root.querySelector('#ageTables');
  host.textContent = '';
  const per = Math.ceil(AGE_TABLE.length / 3);
  for (let t = 0; t < 3; t++) {
    const rows = AGE_TABLE.slice(t * per, (t + 1) * per);
    const table = document.createElement('table');
    table.className = 'age';
    table.innerHTML = '<tr><th>재령일</th><th>재령계수(α)</th></tr>' +
      rows.map(([d, a]) => `<tr data-d="${d}"><td>${d}</td><td>${a.toFixed(2)}</td></tr>`).join('');
    host.appendChild(table);
  }

  // 타격방향 보정표
  const fmt = (v) => (v === null ? '-' : v.toFixed(1));
  root.querySelector('#dirTable').innerHTML =
    '<tr><th rowspan="2">반발경도</th><th colspan="4">수평과 이루는 각도</th></tr>' +
    '<tr><th>+90</th><th>+45</th><th>-45</th><th>-90</th></tr>' +
    ANGLE_TABLE.map((r) => `<tr data-r="${r[0]}"><th>${r[0]}</th>${r.slice(1).map((v, i) => `<td data-a="${ANGLE_COLUMNS[i]}">${fmt(v)}</td>`).join('')}</tr>`).join('');
}

/** 칸 번호(0~19) ↔ 격자 위치. order: 'row' = 가로로 번호, 'col' = 세로로 번호 */
export function cellIndex(r, c, order) {
  return order === 'col' ? c * GRID.rows + r : r * GRID.cols + c;
}

const fmtDate = (s) => (s ? s.replaceAll('-', '.') : '');
const signed = (v, d = 1) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}`;

/** 상태와 계산 결과를 양식에 반영 */
export function renderSheet(state, calc, root = document) {
  const q = (sel) => root.querySelector(sel);
  const qa = (sel) => root.querySelectorAll(sel);

  // 타점 20개
  for (let r = 0; r < GRID.rows; r++) {
    for (let c = 0; c < GRID.cols; c++) {
      const i = cellIndex(r, c, state.order);
      const g = q(`#gridSvg g[data-r="${r}"][data-c="${c}"]`);
      const circle = g.querySelector('circle'), text = g.querySelector('text.r'), slash = g.querySelector('line.slash'), idx = g.querySelector('text.i');
      const v = state.values[i];
      const ex = !!calc.flags?.[i];
      text.textContent = Number.isFinite(v) ? String(v) : '';
      text.classList.toggle('ex', ex);
      circle.classList.toggle('ex', ex);
      slash.setAttribute('visibility', ex ? 'visible' : 'hidden');
      idx.textContent = String(i + 1).padStart(2, '0');
    }
  }

  // 타격 방향 표시
  const a = state.angle;
  qa('#angleSvg .ang').forEach((g) => g.classList.toggle('on', a !== null && Number(g.dataset.a) === a));
  q('#angleOther').textContent = a !== null && ![90, 0, -90].includes(a) ? `${a > 0 ? '+' : ''}${a}°` : '';

  // 값 바인딩
  const alphaText = calc.alpha === null ? '' : calc.alpha.toFixed(calc.alphaInterpolated ? 3 : 2);
  const bind = {
    site: state.site, location: state.location, tester: state.tester, supervisor: state.supervisor,
    pour: fmtDate(state.pourDate), test: fmtDate(state.testDate),
    age: calc.ageDays ?? '',
    R0: calc.R0 === null || calc.retest ? '' : calc.R0.toFixed(1),
    A: calc.A === null || calc.retest ? '' : calc.A.toFixed(1),
    alpha: calc.retest ? '' : alphaText,
    alphaSide: calc.retest ? '' : alphaText,          // "재령보정계수 : 49 일" 옆에 적는 같은 값
    Fc: calc.retest ? '재시험' : calc.Fc === null ? '' : calc.Fc.toFixed(1),
  };
  qa('#page1 [data-bind]').forEach((n) => {
    n.textContent = bind[n.dataset.bind] ?? '';
    n.classList.toggle('bad', n.dataset.bind === 'Fc' && calc.retest);
  });
  q('#alphaNote').hidden = !bind.alphaSide;           // 재령계수가 없으면(타설일 미입력, 재시험) 숨김

  // 계산 메모: 제외값이나 각도 보정이 있을 때만 근거를 남긴다
  const parts = [];
  if (calc.excluded && !calc.retest) parts.push(`평균 ${calc.meanAll.toFixed(1)} → ±20% 초과 ${calc.excluded}개 제외 → 재평균 ${calc.meanKept.toFixed(1)}`);
  if (calc.angleDelta) parts.push(`타격각도 ${a > 0 ? '+' : ''}${a}° 보정 ${signed(calc.angleDelta)}`);
  q('#memo').textContent = parts.length && calc.R0 !== null && !calc.retest ? `※ ${parts.join(' / ')} → R₀ ${calc.R0.toFixed(1)}` : '';

  // 참고표 강조: 사용된 재령 행, 사용된 보정 칸
  const days = calc.alphaOverrideUsed ? null : calc.ageDays;
  qa('#ageTables tr[data-d]').forEach((tr) => tr.classList.remove('hit'));
  if (Number.isFinite(days)) {
    const hit = new Set();
    const exact = AGE_TABLE.find(([d]) => d === days);
    if (exact) hit.add(exact[0]);
    else {
      const lo = [...AGE_TABLE].reverse().find(([d]) => d < days);
      const hi = AGE_TABLE.find(([d]) => d > days);
      if (lo && hi) { hit.add(lo[0]); hit.add(hi[0]); } else if (days > AGE_TABLE[AGE_TABLE.length - 1][0]) hit.add(AGE_TABLE[AGE_TABLE.length - 1][0]);
    }
    hit.forEach((d) => q(`#ageTables tr[data-d="${d}"]`)?.classList.add('hit'));
  }

  qa('#dirTable td').forEach((td) => td.classList.remove('hit', 'hitrow'));
  const R = calc.meanKept ?? calc.meanAll;
  if (R !== null && a) {
    const grid = ANGLE_TABLE.map((r) => r[0]);
    const lo = [...grid].reverse().find((g) => g <= R) ?? grid[0];
    const hi = grid.find((g) => g >= R) ?? grid[grid.length - 1];
    const rowsHit = new Set([lo, hi]);
    const colsHit = ANGLE_COLUMNS.includes(a) ? [a] : ANGLE_COLUMNS.filter((c) => (a > 0 ? c > 0 : c < 0));
    rowsHit.forEach((g) => colsHit.forEach((col) => {
      q(`#dirTable tr[data-r="${g}"] td[data-a="${col}"]`)?.classList.add(ANGLE_COLUMNS.includes(a) ? 'hit' : 'hitrow');
    }));
  }
}

/** 화면 너비에 맞춰 양식 배율(--k)을 정한다 */
export function fitSheet() {
  const host = document.getElementById('sheetHost');
  const parent = host.parentElement;
  const cs = getComputedStyle(parent);
  const avail = parent.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const k = Math.max(0.28, Math.min(1, (avail - 2) / 1342));
  host.style.setProperty('--k', k.toFixed(4));
}
