// 결과기록지 이미지를 읽어 구조화된 기록을 돌려준다.
//
// 실제 촬영본은 조건이 제각각이라 한 번에 읽히지 않을 수 있다. 그래서 여러 시도를 순서대로 해 보고,
// "인식값의 평균 == 기록지에 찍힌 AVERAGE" 로 검증되는 결과가 나오면 거기서 멈춘다.
//   1) 첫 시도 (조명이 어둡거나 한쪽이 그늘졌다면 조명 보정본으로)
//   2) 큰 사진 속에 기록지가 작게 찍혔다면 → 글줄이 모인 영역(ROI)만 잘라 확대해서 재시도
//   3) 읽힌 게 기록지 같지 않다면 사진이 돌아가 있을 수 있으므로 → 90/270/180° 회전해서 재시도
//   4) 기록지 오른쪽 가장자리의 세로 인쇄가 섞였을 때를 위해 오른쪽을 잘라내거나, 조명/검출 임계값을 바꿔 재시도
import { crop, cropRotated, hstack, rotate, resize, analyzeIllumination, normalizeIllumination } from './imageops.js';
import { adjustQuad, quadCorners, quadAabb, uvOf, unionQuad } from './engine.js';
import { parseRecord, parseAngleText, clearAngleWarning } from './record.js';

const RIGHT_CROPS = [1, 0.82, 0.7];       // 오른쪽을 잘라내는 비율 후보 (처음 것이 기본)
const ALT_BIN = 0.3;                      // 기본 임계값(엔진 옵션)으로 안 읽힐 때 쓰는 PaddleOCR 기본값
const ROI_TARGET_H = 90;                  // 기록지 줄 박스의 기준 높이(px) — 샘플 기록지에서의 값
const ROI_MIN_SIDE = 1100;                // 이보다 작은 이미지는 ROI 단계를 건너뜀

function isGood(rec) {
  return rec.count >= 5 && rec.avgMatch === true && rec.seqOk;
}

/**
 * ANGLE 의 값(보통 외딴 글리프 하나)은 한 번 읽어서는 불안정하다 (0 → 9/5/G, 또는 아예 빈칸).
 *  - 줄이 "ANGLE" + 글리프로 나뉘어 검출됐다면, 각 조각을 똑바로 펴서 간격을 좁혀 이어붙인 이미지를 읽는다.
 *    ("R 01 46" 같은 일반 행처럼 문맥이 이어지게 하는 것 — 간격이 넓은 원본 줄을 그대로 읽는 것보다 훨씬 안정적)
 *  - 간격/여백을 달리한 여러 변형을 읽어 다수결로 정한다. 샘플과 합성 사진 8종에서 오답 숫자 0표.
 * 확신이 서지 않으면 null (→ UI 에서 사용자에게 확인을 요청).
 */
export async function voteAngle(engine, im, box, parts) {
  const reads = [];
  if (parts && parts.length >= 2) {
    for (const grow of [0, 0.06]) for (const gap of [0.15, 0.3, 0.5, 0.8]) reads.push(await engine.recognizeImage(composeParts(im, parts, grow, gap), 'alnum'));
  } else {
    const base = 'theta' in box ? box : { cx: (box.x0 + box.x1) / 2, cy: (box.y0 + box.y1) / 2, w: box.x1 - box.x0, h: box.y1 - box.y0, theta: 0 };
    for (const grow of [-0.08, -0.04, 0, 0.04]) for (const ext of [0, 0.1, 0.2, 0.4]) reads.push(await engine.recognizeBox(im, adjustQuad(base, { grow, extendRight: ext }), 'alnum'));
  }
  const votes = new Map();
  for (const r of reads) {
    const a = parseAngleText(r.text, r.conf);
    if (a && a.conf >= 0.5) votes.set(a.value, (votes.get(a.value) || 0) + 1);
  }
  const ranked = [...votes].sort((x, y) => y[1] - x[1]);
  if (!ranked.length) return null;
  const [top, topN] = ranked[0];
  const second = ranked[1]?.[1] ?? 0;
  return topN >= 3 && topN >= second * 2 ? { value: top, votes: topN, total: reads.length } : null;
}

/** 같은 줄의 조각(quad)들을 똑바로 펴서 높이를 맞추고 gapFrac*높이 만큼 띄워 이어붙인다 */
function composeParts(im, parts, grow, gapFrac) {
  const sorted = [...parts].sort((a, b) => uvOf(a.cx, a.cy, a.theta).u - uvOf(b.cx, b.cy, b.theta).u);
  const uq = unionQuad(sorted, sorted[0].theta);
  const th = uq.theta, cos = Math.cos(th), sin = Math.sin(th);
  const H = uq.h * (1 + 2 * grow);
  const vC = uvOf(uq.cx, uq.cy, th).v;                 // 줄의 중심선 (조각마다 조금씩 어긋난 높이를 맞춘다)
  const crops = sorted.map((q) => {
    const u = uvOf(q.cx, q.cy, th).u;
    return cropRotated(im, u * cos - vC * sin, u * sin + vC * cos, q.w, H, th);
  });
  return hstack(crops, gapFrac * H, Math.round(H * 0.1));
}

/**
 * 글줄들 가운데 같은 세로 띠에 모여 있는 가장 큰 묶음(= 기록지)의 영역을 찾는다.
 * 사진이 기울어져 있으면 그 기울기대로 기울어진 사각형이므로, 잘라낼 때 똑바로 펴지는 효과(수평 보정)도 난다.
 * 반환: { cx,cy,w,h,theta (회전 사각형), scale (줄 높이를 기준값으로 맞추는 배율), areaRatio, count } | null
 */
export function findRoi(lines, theta, W, H) {
  const items = [];
  for (const l of lines) {
    const q = l.quad;
    if (!q || q.h < 6 || q.w / q.h < 1.2) continue;          // 가로로 긴 글줄 모양만
    const us = quadCorners(q).map(([x, y]) => uvOf(x, y, theta).u);
    items.push({ q, u0: Math.min(...us), u1: Math.max(...us) });
  }
  if (items.length < 5) return null;
  let best = null;
  for (const a of items) {
    const cl = items.filter((b) => Math.min(a.u1, b.u1) - Math.max(a.u0, b.u0) >= 0.5 * Math.min(a.u1 - a.u0, b.u1 - b.u0));
    if (!best || cl.length > best.length) best = cl;
  }
  if (best.length < 5) return null;

  const uq = unionQuad(best.map((x) => x.q), theta);
  const w = uq.w * 1.3, h = uq.h * 1.06;                    // 좌우 15%, 상하 3% 여유
  const hs = best.map((x) => x.q.h).sort((a, b) => a - b);
  const scale = Math.max(0.5, Math.min(3.5, ROI_TARGET_H / hs[hs.length >> 1]));
  return { cx: uq.cx, cy: uq.cy, w, h, theta, scale, areaRatio: (w * h) / (W * H), count: best.length };
}

/** ROI 이미지 좌표의 박스를 원본(회전된 이미지) 좌표의 축 정렬 박스로 되돌린다 */
function mapBoxBack(b, map) {
  const cos = Math.cos(map.theta), sin = Math.sin(map.theta);
  const xs = [], ys = [];
  for (const [x, y] of [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]]) {
    const u = x / map.s - map.w / 2, v = y / map.s - map.h / 2;
    xs.push(map.cx + u * cos - v * sin); ys.push(map.cy + u * sin + v * cos);
  }
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/**
 * @param {PaddleEngine} engine
 * @param {{data,width,height}} img
 * @param {object} [o]
 * @param {number} [o.rotation]   고정 회전(0/90/180/270). 지정하면 자동 방향 탐색을 하지 않음
 * @param {number} [o.rightCrop]  고정 크롭 비율. 지정하면 이 값만 시도
 * @param {(msg:string, frac:number)=>void} [o.onProgress]
 */
export async function readRecord(engine, img, o = {}) {
  const log = [];
  const say = (msg, frac) => o.onProgress && o.onProgress(msg, frac);
  const variants = { raw: img, norm: null };
  const variant = (prep) => (prep === 'norm' ? (variants.norm ||= normalizeIllumination(img)) : variants.raw);

  async function attempt(prep, rot, right, roi, bin) {
    let im = variant(prep);
    if (rot) im = rotate(im, rot);
    if (right < 1) im = crop(im, 0, 0, im.width * right, im.height);
    let map = null;
    if (roi) {
      const c = cropRotated(im, roi.cx, roi.cy, roi.w, roi.h, roi.theta);   // 기록지만 똑바로 펴서 잘라냄
      im = Math.abs(roi.scale - 1) > 0.05 ? resize(c, c.width * roi.scale, c.height * roi.scale) : c;
      map = { cx: roi.cx, cy: roi.cy, theta: roi.theta, w: c.width, h: c.height, s: im.width / c.width };
    }
    const lines = await engine.recognize(im, { binThresh: bin });
    const rec = parseRecord(lines);
    log.push({ prep, rot, right, bin: bin ?? engine.opt.binThresh, roi: !!roi, count: rec.count, avgMatch: rec.avgMatch, score: Number(rec.score.toFixed(1)) });
    return { rec, prep, rot, right, bin, lines, im, map, roi: roi || null };
  }

  let best = null;
  const consider = (r) => { if (!best || r.rec.score > best.rec.score) best = r; return r; };

  /** 큰 사진에서 기록지 영역만 잘라 확대해 다시 읽는다 */
  async function tryRoi(r, prep, rot, bin) {
    if (Math.max(r.im.width, r.im.height) < ROI_MIN_SIDE || r.rec.count < 3) return null;   // 행이 거의 안 읽혔으면 영역을 짐작할 수 없다
    const roi = findRoi(r.lines, r.lines.theta || 0, r.im.width, r.im.height);
    // 기록지가 화면을 채우고 있고(여백 없음) 크기도 적당하고 거의 똑바르면 ROI 로 얻을 게 없다
    if (!roi || (roi.areaRatio > 0.75 && roi.scale > 0.7 && roi.scale < 1.3 && Math.abs(roi.theta) < 2.5 * Math.PI / 180)) return null;
    say('기록지 영역을 잘라 똑바로 펴서 다시 읽는 중…', 0.5);
    return consider(await attempt(prep, rot, 1, roi, bin));
  }

  async function run() {
    const userRot = o.rotation != null, userCrop = o.rightCrop != null;
    const crops = userCrop ? [o.rightCrop] : RIGHT_CROPS;
    let rot = o.rotation ?? 0;

    // 어둡거나 한쪽이 그늘진 사진이면 조명 보정본을 먼저 쓴다
    const ill = analyzeIllumination(img);
    const preps = ill.median < 170 || ill.unevenness > 1.35 ? ['norm', 'raw'] : ['raw', 'norm'];

    const tried = new Set();
    const go = async (prep, rotation, right, bin) => {
      const k = [prep, rotation, right, bin].join('|');
      if (tried.has(k)) return null;
      tried.add(k);
      return consider(await attempt(prep, rotation, right, null, bin));
    };

    // 1) 첫 시도 (+ 큰 사진이면 ROI)
    say('기록지 인식 중…', 0.1);
    const first = await go(preps[0], rot, crops[0], undefined);
    if (isGood(first.rec)) return;
    const roi1 = await tryRoi(first, preps[0], rot);
    if (roi1 && isGood(roi1.rec)) return;

    // 2) 기록지 같지 않은 결과면 방향부터 의심한다 (뒤집히거나 누운 글자는 엉뚱한 숫자로 읽힘).
    //    뒤집힘(180°)이 가장 흔해서 먼저 본다.
    if (!userRot && !userCrop && !best.rec.valid) {
      for (const cand of [180, 90, 270]) {
        say(`${cand}° 회전해서 재시도…`, 0.7);
        const rc = await go(preps[0], cand, crops[0], undefined);
        if (rc && isGood(rc.rec)) return;
        const rr = rc && rc.rec.valid && await tryRoi(rc, preps[0], cand);   // 방향이 맞아 보일 때만 영역 확대
        if (rr && isGood(rr.rec)) return;
        if (best.rec.valid) break;
      }
      rot = best.rot;
    }

    // 행이 거의 읽히지 않았다면 크롭/조명을 바꿔도 소용없다 (기록지가 너무 작게 찍혔거나 기록지가 아님)
    if (best.rec.count < 3) return;

    // 3) 크롭 / 조명 / 검출 임계값을 바꿔 가며 재시도
    const plan = [
      ...crops.slice(1).map((c) => [preps[0], c, undefined]),                 // 가장자리 인쇄 제외
      ...crops.filter((c) => c >= 0.8).map((c) => [preps[1], c, undefined]),   // 반대쪽 조명 처리
      [preps[0], crops[0], ALT_BIN], [preps[1], crops[0], ALT_BIN],            // PaddleOCR 기본 임계값
    ];
    let n = 0;
    for (const [prep, right, bin] of plan) {
      say(right < 1 ? `가장자리 인쇄를 제외하고 재시도 (${Math.round(right * 100)}%)…` : '조건을 바꿔 재시도…', Math.min(0.92, 0.75 + 0.03 * ++n));
      const r = await go(prep, rot, right, bin);
      if (r && isGood(r.rec)) return;
    }
  }
  await run();

  const rec = best.rec;
  rec.angleSource = rec.angle !== null ? 'ocr' : null;
  if (rec.angle === null && rec.angleBox) {
    say('ANGLE 확인 중…', 0.95);
    const v = await voteAngle(engine, best.im, rec.angleBox, rec.angleParts);
    if (v) { rec.angle = v.value; rec.angleSource = 'vote'; }
  }
  if (rec.angle !== null) clearAngleWarning(rec);

  // 확대해서 읽은 경우, 행 박스를 (회전된) 원본 이미지 좌표로 되돌린다 (미리보기 하이라이트용)
  if (best.map) for (const r of rec.rows) r.box = mapBoxBack(r.box, best.map);
  return { ...rec, rotation: best.rot, rightCrop: best.right, roi: best.roi, prep: best.prep, lines: best.lines, im: best.im, passes: log };
}
