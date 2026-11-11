// 사진대지 양식 (슈미트/사진대지.xlsx): A4 세로 한 쪽에 사진 칸 2개, 칸마다 시험내용·시험위치·타설일·시험일 표, 맨 아래 오른쪽에 현장명.
//
// 엑셀의 열 너비·행 높이(pt)를 그대로 옮겨 px(96dpi: px = pt × 4/3)로 배치한다.
//   열 A~H = 75 / 47.4 / 47.4 / 47.4 / 66.6 / 47.4 / 47.4 / 47.4 pt (합 426pt),  행 1=28.2, 2=22.2, 3~28=24.6, 29~30=16.8 pt
//   사진 칸 = B~H열 × 11행 (A열은 "사진-N" 표시), 그 아래 2행이 표. 여백 좌우 가운데, 위 42.5pt.
// 화면 미리보기(DOM)와 PDF(캔버스)가 같은 좌표를 쓰도록 모든 위치를 이 파일의 상수에서 만든다.
import { fmtDotDate } from './docs.js';

const PX = 4 / 3;
export const PHOTO_PAGE = { w: 794, h: 1123 };                  // A4 세로 @96dpi
const COL = [75, 47.4, 47.4, 47.4, 66.6, 47.4, 47.4, 47.4].map((v) => v * PX);   // A~H
const W = COL.reduce((a, b) => a + b, 0);                       // 568px
const ROW = 24.6 * PX;                                          // 3~28행
const SMALL_ROW = 16.8 * PX;                                    // 29~30행
const TITLE_H = 28.2 * PX;
const GAP_H = 22.2 * PX;
const X0 = ((595.28 - 426) / 2) * PX;                           // 가로 가운데 맞춤
const Y0 = 42.52 * PX;                                          // 위 여백
const PHOTO_ROWS = 11;
const BLOCK_H = (PHOTO_ROWS + 2) * ROW;                         // 사진 11행 + 표 2행
const LINE = 1.33;                                              // 1pt 선

export const blockTop = (b) => Y0 + TITLE_H + GAP_H + b * BLOCK_H;

/** 사진 칸(B~H열 × 11행)의 위치 — 쪽 좌표(px) */
export const photoRect = (b) => ({ x: X0 + COL[0], y: blockTop(b), w: W - COL[0], h: PHOTO_ROWS * ROW });

/** 테두리선을 덮지 않도록 안쪽으로 줄인 사진 영역 */
export function photoInset(b, pad = LINE) {
  const r = photoRect(b);
  return { x: r.x + pad, y: r.y + pad, w: r.w - 2 * pad, h: r.h - 2 * pad };
}

/**
 * 가로 iw × 세로 ih 사진을 rect 안에 넣는 위치.
 * mode 'contain' = 칸에 맞춤(전체가 보이고 남는 곳은 흰 바탕), 'cover' = 칸 채우기(넘치는 부분은 잘림)
 */
export function fitRect(iw, ih, rect, mode) {
  const k = mode === 'cover' ? Math.max(rect.w / iw, rect.h / ih) : Math.min(rect.w / iw, rect.h / ih);
  const w = iw * k, h = ih * k;
  return { x: rect.x + (rect.w - w) / 2, y: rect.y + (rect.h - h) / 2, w, h };
}

/**
 * 문서/상태에서 사진대지에 적히는 글 (시험위치·타설일·시험일·현장명은 시험 정보에서 자동)
 * @param extra  { head, foot } 인쇄 머리글(오른쪽 위)·바닥글(맨 아래 오른쪽). 회사 양식마다 다르므로 코드에 넣지 않고
 *               사용자가 4번 카드에서 적은 값(이 기기에만 저장, js/settings.js)을 받는다
 */
export const photoTexts = (src, extra = {}) => ({
  site: src.site || '', work: src.workName ?? '', location: src.location || '',
  pour: fmtDotDate(src.pourDate), test: fmtDotDate(src.testDate),
  head: extra.head || '', foot: extra.foot || '',
});

const f = (n) => n.toFixed(2);
const pos = (x, y, w, h) => `left:${f(x)}px;top:${f(y)}px;width:${f(w)}px;height:${f(h)}px`;

/** 사진대지 한 쪽(.page.photo, 794×1123)을 만든다. 글과 사진은 fillPhotoPage 로 채운다 */
export function buildPhotoPage() {
  const page = document.createElement('div');
  page.className = 'page photo';
  const capCols = [COL[0], COL[1] + COL[2] + COL[3], COL[4], COL[5] + COL[6] + COL[7] - LINE];   // 합 = 표 너비(W - LINE)
  let html = `<div class="abs ph-head" data-ph="head"></div>`;
  html += `<div class="abs ph-title" style="${pos(X0, Y0, W, TITLE_H)}">사 진 대 지</div>`;
  for (let b = 0; b < 2; b++) {
    const top = blockTop(b);
    const boxH = PHOTO_ROWS * ROW;
    const inset = photoInset(b);
    html += `<div class="abs ph-box" style="${pos(X0, top, W, boxH)}"></div>`;
    html += `<div class="abs ph-vline" style="left:${f(X0 + COL[0] - LINE / 2)}px;top:${f(top)}px;width:${LINE}px;height:${f(boxH)}px"></div>`;
    html += `<div class="abs ph-label" data-slot="${b}" style="${pos(X0, top, COL[0], boxH)}">사진-${b + 1}</div>`;
    html += `<div class="abs ph-img" data-slot="${b}" style="${pos(inset.x, inset.y, inset.w, inset.h)}"><img class="ph-shot" alt="" hidden></div>`;
    // 표는 border-collapse 라서 바깥 선이 가장자리에 걸쳐 그려진다 → 사진 칸 테두리(안쪽으로 그려짐)와 선의 중심이 겹치도록 반 줄씩 안쪽에 둔다
    html += `<table class="abs ph-cap" style="left:${f(X0 + LINE / 2)}px;top:${f(top + boxH - LINE / 2)}px;width:${f(W - LINE)}px">` +
      `<colgroup>${capCols.map((w) => `<col style="width:${f(w)}px">`).join('')}</colgroup>` +
      `<tr><th>시험내용</th><td data-ph="work"></td><th>시험위치</th><td data-ph="location"></td></tr>` +
      `<tr><th>타 설 일</th><td data-ph="pour"></td><th>시 험 일</th><td data-ph="test"></td></tr></table>`;
  }
  const row30 = blockTop(1) + BLOCK_H + SMALL_ROW;               // 29행 아래
  const siteX = X0 + COL[0] + COL[1] + COL[2] + COL[3] + COL[4];
  html += `<div class="abs ph-site" data-ph="site" style="${pos(siteX, row30, COL[5] + COL[6] + COL[7], SMALL_ROW)}"></div>`;
  html += `<div class="abs ph-foot" data-ph="foot"></div>`;
  page.innerHTML = html;
  return page;
}

/**
 * 글과 사진을 채운다.
 * @param texts  photoTexts() 의 결과
 * @param slots  [{ url }|null, { url }|null] — 이 쪽의 사진 2칸 (없으면 "사진-N" 표시만)
 * @param fit    'contain' | 'cover'
 */
export function fillPhotoPage(page, texts, slots, fit) {
  page.querySelectorAll('[data-ph]').forEach((n) => { n.textContent = texts[n.dataset.ph] ?? ''; });
  for (let b = 0; b < 2; b++) {
    const s = slots[b];
    const img = page.querySelector(`.ph-img[data-slot="${b}"] img`);
    if (s?.url) {
      if (img.getAttribute('src') !== s.url) img.setAttribute('src', s.url);
      img.style.objectFit = fit;
      img.hidden = false;
    } else {
      img.removeAttribute('src');
      img.hidden = true;
    }
    page.querySelector(`.ph-label[data-slot="${b}"]`).hidden = !!s;     // 사진이 들어가면 "사진-N" 안내는 숨긴다
  }
}

/** PDF 용: 사진을 캔버스에 직접 그린다 (SVG 안에는 사진을 넣지 않는다 — blob 주소를 못 읽고, data URL 은 무겁다) */
export function drawShots(ctx, scale, bitmaps, fit) {
  bitmaps.forEach((bmp, b) => {
    if (!bmp) return;
    const r = photoInset(b);
    const d = fitRect(bmp.width, bmp.height, r, fit);
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x * scale, r.y * scale, r.w * scale, r.h * scale);
    ctx.clip();
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, d.x * scale, d.y * scale, d.w * scale, d.h * scale);
    ctx.restore();
  });
}
