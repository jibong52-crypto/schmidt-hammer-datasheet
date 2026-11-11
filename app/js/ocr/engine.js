// PP-OCRv4 (PaddleOCR, Apache-2.0) ONNX 추론 엔진 — 브라우저/Node 공용.
// 검출(DB) → 회전 사각형 후처리 → 똑바로 펴서 인식(CRNN, CTC) 순으로 동작한다.
// ort(onnxruntime-web 또는 onnxruntime-node)를 주입받아 환경에 의존하지 않는다.
import { crop, cropRotated, resize } from './imageops.js';

const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
const DEG = Math.PI / 180;

export const WHITELIST = {
  // 기록지에 나올 수 있는 글자: 숫자, 영문 대문자, 기호
  alnum: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ.-+:/ ',
  digits: '0123456789.-+ ',
};

export const DEFAULTS = {
  detMaxSide: 1280,     // 검출 입력의 긴 변 상한(px). 클수록 정밀하지만 느림
  detNorm: 'imagenet',  // 'imagenet' | 'plain'
  // 확률맵 이진화 임계값. PaddleOCR 기본은 0.3 이지만, 기록지는 오른쪽 가장자리의 세로 인쇄가 행과 붙어
  // 하나의 덩어리가 되는 일이 잦아 0.6 이 안정적이었다(샘플·합성 사진 비교). 실패 시 reader 가 0.3 으로 재시도한다.
  binThresh: 0.6,
  boxThresh: 0.5,       // 영역 평균 확률 임계값
  unclipRatio: 1.5,     // 박스 확장 비율
  minBoxSide: 4,        // 검출 해상도 기준 최소 변 길이(px)
  recHeight: 48,
  recNorm: 'std',       // 'std'((x-0.5)/0.5) | 'plain'
  recMaxWidth: 2400,
};

/* ───────── 회전 사각형(quad) 기하 ─────────  quad = { cx, cy, w, h, theta } (theta: 가로축 기울기, 시계방향 +) */
export function quadCorners(q) {
  const c = Math.cos(q.theta), s = Math.sin(q.theta), hw = q.w / 2, hh = q.h / 2;
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([u, v]) => [q.cx + u * c - v * s, q.cy + u * s + v * c]);
}
export function quadAabb(q) {
  const p = quadCorners(q);
  return { x0: Math.min(...p.map((a) => a[0])), y0: Math.min(...p.map((a) => a[1])), x1: Math.max(...p.map((a) => a[0])), y1: Math.max(...p.map((a) => a[1])) };
}
/** 기울기 theta 방향 좌표계에서 본 위치: u = 글줄 방향, v = 글줄에 수직(행 위치) */
export const uvOf = (x, y, theta) => ({ u: x * Math.cos(theta) + y * Math.sin(theta), v: -x * Math.sin(theta) + y * Math.cos(theta) });
/** 여러 quad 를 모두 감싸는 theta 방향의 quad */
export function unionQuad(quads, theta) {
  const c = Math.cos(theta), s = Math.sin(theta);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const q of quads) for (const [x, y] of quadCorners(q)) {
    const u = x * c + y * s, v = -x * s + y * c;
    if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
  }
  const um = (u0 + u1) / 2, vm = (v0 + v1) / 2;
  return { cx: um * c - vm * s, cy: um * s + vm * c, w: u1 - u0, h: v1 - v0, theta };
}
/** quad 를 세로로 grow(h 의 비율)만큼 키우고, 오른쪽으로 extendRight(h 의 비율)만큼 늘린다 */
export function adjustQuad(q, { grow = 0, extendRight = 0 } = {}) {
  const c = Math.cos(q.theta), s = Math.sin(q.theta);
  const dw = extendRight * q.h;
  return { cx: q.cx + (dw / 2) * c, cy: q.cy + (dw / 2) * s, w: q.w + dw, h: q.h * (1 + 2 * grow), theta: q.theta };
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

/**
 * 투영 프로파일로 글줄 기울기(라디안)를 추정한다. 글자 확률이 높은 픽셀들을 각도 θ 의 글줄 직교 좌표 v 로
 * 히스토그램을 만들 때, θ 가 실제 글줄 방향과 맞으면 줄마다 값이 몰려 Σ(빈 개수²) 가 최대가 된다.
 * 글자 픽셀이 너무 적거나 뚜렷한 극대가 없으면 null.
 */
function estimateSkew(prob, W, H, sx, sy) {
  const pts = [];
  for (let i = 0; i < prob.length; i++) if (prob[i] > 0.5) pts.push(i);
  if (pts.length < 200) return null;
  const step = Math.max(1, Math.floor(pts.length / 60000));        // 많으면 솎아서 속도 확보
  const xs = [], ys = [];
  for (let k = 0; k < pts.length; k += step) { const y = (pts[k] / W) | 0; xs.push((pts[k] - y * W + 0.5) * sx); ys.push((y + 0.5) * sy); }
  const n = xs.length;
  const binW = Math.max(2, 2 * (sx + sy) / 2);                        // 빈 폭: 검출 맵 기준 약 2px
  const span = Math.hypot(W * sx, H * sy);
  const bins = Math.ceil((2 * span) / binW) + 2;
  const hist = new Int32Array(bins);
  const score = (deg) => {
    const t = deg * DEG, s = Math.sin(t), c = Math.cos(t);
    hist.fill(0);
    for (let i = 0; i < n; i++) hist[((-xs[i] * s + ys[i] * c + span) / binW) | 0]++;
    let sum = 0;
    for (let i = 0; i < bins; i++) sum += hist[i] * hist[i];
    return sum;
  };
  let best = 0, bestScore = -1;
  for (let d = -25; d <= 25; d += 1) { const sc = score(d); if (sc > bestScore) { bestScore = sc; best = d; } }
  const base = score(0);
  for (let d = best - 1; d <= best + 1; d += 0.2) { const sc = score(d); if (sc > bestScore) { bestScore = sc; best = d; } }
  // 0° 보다 뚜렷하게 좋을 때만 기울어졌다고 본다 (줄이 없는 사진에서 헛된 각도 방지)
  return bestScore > base * 1.03 || Math.abs(best) < 0.5 ? best * DEG : null;
}
const uRange = (q, theta) => { const u = quadCorners(q).map(([x, y]) => uvOf(x, y, theta).u); return [Math.min(...u), Math.max(...u)]; };

/**
 * 글줄들이 늘어선 "열"의 좌우 범위. 한 행이 'R' / '01' / '46' 처럼 여러 조각으로 검출되므로
 * 같은 행(글줄에 수직인 좌표 v 가 비슷한)의 조각을 먼저 묶어서 행의 좌우 끝을 구하고,
 * 전형적인 행의 좌우 끝(중앙값)에서 열 너비의 25% 만큼 여유를 둔다. 행이 5개 미만이면 null.
 */
function columnCut(quads, theta) {
  const cand = quads.filter((q) => q.h > 6);
  if (cand.length < 5) return null;
  const medH = median(cand.map((q) => q.h));
  const rows = [];
  for (const q of [...cand].sort((a, b) => uvOf(a.cx, a.cy, theta).v - uvOf(b.cx, b.cy, theta).v)) {
    const v = uvOf(q.cx, q.cy, theta).v;
    const [u0, u1] = uRange(q, theta);
    const row = rows[rows.length - 1];
    if (row && Math.abs(row.v - v) < medH / 2) {
      row.u0 = Math.min(row.u0, u0); row.u1 = Math.max(row.u1, u1); row.h = Math.max(row.h, q.h); row.n++;
      row.v = (row.v * (row.n - 1) + v) / row.n;
    } else rows.push({ v, u0, u1, h: q.h, n: 1 });
  }
  const clean = rows.filter((r) => r.h >= 0.4 * medH && r.h <= 1.8 * medH && r.u1 - r.u0 >= 1.5 * r.h);
  if (clean.length < 5) return null;
  const lo = median(clean.map((r) => r.u0)), hi = median(clean.map((r) => r.u1));
  const width = hi - lo;
  if (width < 50) return null;
  return { uMin: lo - 0.25 * width, uMax: hi + 0.25 * width, medH };
}
/** 열 바깥으로 삐져나갔거나 비정상적으로 키가 큰(다른 글줄과 붙은) 덩어리인가 */
function outsideColumn(q, theta, cut) {
  const [u0, u1] = uRange(q, theta);
  return u1 > cut.uMax || u0 < cut.uMin || q.h > 2.2 * cut.medH;
}

export class PaddleEngine {
  constructor({ ort, detSession, recSession, chars, options }) {
    this.ort = ort;
    this.det = detSession;
    this.rec = recSession;
    this.chars = chars; // index 0 = CTC blank
    this.opt = { ...DEFAULTS, ...(options || {}) };
    this._masks = new Map();
  }

  /**
   * @param {object} p
   * @param {object} p.ort            onnxruntime 모듈
   * @param {Uint8Array|string} p.det 검출 모델(바이트 또는 경로/URL)
   * @param {Uint8Array|string} p.rec 인식 모델
   * @param {string} p.dict           사전 텍스트(줄 단위)
   */
  static async create({ ort, det, rec, dict, sessionOptions, options }) {
    const so = sessionOptions || {};
    const [detSession, recSession] = [await ort.InferenceSession.create(det, so), await ort.InferenceSession.create(rec, so)];
    const lines = dict.split('\n').map((s) => s.replace(/\r$/, ''));
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    const chars = ['', ...lines, ' ']; // blank + dict + space
    return new PaddleEngine({ ort, detSession, recSession, chars, options });
  }

  // ---------- 검출 ----------
  /**
   * @param {object} [p]
   * @param {number} [p.maxSide]    이 호출에서만 쓸 검출 해상도 상한
   * @param {number} [p.binThresh]  이 호출에서만 쓸 이진화 임계값
   * @returns {{quads: object[], theta: number}} 글줄 후보(회전 사각형)와 전체 기울기(라디안)
   */
  async detect(img, { maxSide = this.opt.detMaxSide, binThresh = this.opt.binThresh } = {}) {
    const o = this.opt;
    const long = Math.max(img.width, img.height);
    const k = long > maxSide ? maxSide / long : 1;
    const dw = Math.max(32, Math.ceil((img.width * k) / 32) * 32);
    const dh = Math.max(32, Math.ceil((img.height * k) / 32) * 32);
    const small = resize(img, dw, dh);

    const plane = dw * dh;
    const input = new Float32Array(3 * plane);
    const d = small.data;
    const imagenet = o.detNorm === 'imagenet';
    for (let i = 0, p = 0; i < plane; i++, p += 4) {
      const r = d[p] / 255, g = d[p + 1] / 255, b = d[p + 2] / 255;
      // PaddleOCR 관례: BGR 평면 순서, 평균/표준편차는 위치 기준으로 적용
      input[i] = imagenet ? (b - MEAN[0]) / STD[0] : b;
      input[plane + i] = imagenet ? (g - MEAN[1]) / STD[1] : g;
      input[2 * plane + i] = imagenet ? (r - MEAN[2]) / STD[2] : r;
    }
    const tensor = new this.ort.Tensor('float32', input, [1, 3, dh, dw]);
    const out = await this.det.run({ [this.det.inputNames[0]]: tensor });
    const prob = out[this.det.outputNames[0]].data;
    return this._quadsFromMap(prob, dw, dh, img.width / dw, img.height / dh, binThresh);
  }

  /**
   * 확률맵 → 글줄 quad.
   * 기록지 오른쪽 가장자리의 세로 인쇄는 행의 막대그래프와 붙어 하나의 큰 덩어리가 되곤 한다(행이 통째로 망가짐).
   * 그래서 한 번 분석한 뒤, 글줄들이 모인 "열"의 좌우 범위를 추정해 그 바깥 픽셀을 지우고 다시 분석한다.
   * (사진마다 기록지 위치가 달라서 고정 비율로 자르는 것보다 안정적이다)
   */
  _quadsFromMap(prob, W, H, sx, sy, binThresh) {
    let res = this._analyze(prob, W, H, sx, sy, binThresh);
    const cut = columnCut(res.quads, res.theta);
    if (cut && res.quads.some((q) => outsideColumn(q, res.theta, cut))) {
      const masked = new Float32Array(prob);
      const c = Math.cos(res.theta), s = Math.sin(res.theta);
      for (let y = 0; y < H; y++) {
        const Y = (y + 0.5) * sy * s;
        for (let x = 0; x < W; x++) {
          const u = (x + 0.5) * sx * c + Y;
          if (u > cut.uMax || u < cut.uMin) masked[y * W + x] = 0;
        }
      }
      res = this._analyze(masked, W, H, sx, sy, binThresh);
      res.cut = cut;
    }
    return res;
  }

  /** 연결요소마다 주성분 분석(PCA)으로 글줄 방향을 구하고, 그 방향의 최소 외접 사각형을 DB 방식(unclip)으로 키운다. */
  _analyze(prob, W, H, sx, sy, binThresh) {
    const o = this.opt;
    const n = W * H;
    const visited = new Uint8Array(n);
    const stack = new Int32Array(n);
    const order = new Int32Array(n);   // 요소별 픽셀 인덱스를 이어 붙여 저장
    const comps = [];
    let ord = 0;

    for (let s = 0; s < n; s++) {
      if (visited[s] || prob[s] <= binThresh) continue;
      const start = ord;
      let sp = 0;
      stack[sp++] = s; visited[s] = 1;
      let minx = W, miny = H, maxx = 0, maxy = 0, sum = 0;
      while (sp) {
        const p = stack[--sp];
        order[ord++] = p;
        const y = (p / W) | 0, x = p - y * W;
        sum += prob[p];
        if (x < minx) minx = x; if (x > maxx) maxx = x;
        if (y < miny) miny = y; if (y > maxy) maxy = y;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy; if (ny < 0 || ny >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx; if (nx < 0 || nx >= W) continue;
            const q = ny * W + nx;
            if (!visited[q] && prob[q] > binThresh) { visited[q] = 1; stack[sp++] = q; }
          }
        }
      }
      const cnt = ord - start;
      if (Math.min(maxx - minx + 1, maxy - miny + 1) < o.minBoxSide || sum / cnt < o.boxThresh) { ord = start; continue; }
      comps.push({ start, end: ord, cnt, score: sum / cnt });
    }

    // 1) 요소별 무게중심과 주축 방향
    for (const c of comps) {
      let mx = 0, my = 0;
      for (let k = c.start; k < c.end; k++) { const p = order[k], y = (p / W) | 0, x = p - y * W; mx += (x + 0.5) * sx; my += (y + 0.5) * sy; }
      mx /= c.cnt; my /= c.cnt;
      let sxx = 0, syy = 0, sxy = 0;
      for (let k = c.start; k < c.end; k++) {
        const p = order[k], y = (p / W) | 0, x = p - y * W;
        const dx = (x + 0.5) * sx - mx, dy = (y + 0.5) * sy - my;
        sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
      }
      sxx /= c.cnt; syy /= c.cnt; sxy /= c.cnt;
      const half = (sxx + syy) / 2, rad = Math.hypot((sxx - syy) / 2, sxy);
      c.mx = mx; c.my = my;
      c.theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
      c.elong = Math.sqrt((half + rad) / Math.max(half - rad, 1e-9));
    }

    // 2) 사진 전체의 기울기. 글줄이 조각조각 검출되면 요소 하나하나의 방향은 믿기 어려우므로,
    //    글자 픽셀 전체의 가로 투영 히스토그램이 가장 뾰족해지는 각도(투영 프로파일)를 기울기로 삼는다.
    const elongated = comps.filter((c) => c.elong >= 4);
    const horizontal = elongated.filter((c) => Math.abs(c.theta) <= 45 * DEG);
    let thetaG = estimateSkew(prob, W, H, sx, sy);
    if (thetaG === null) {
      const angles = horizontal.map((c) => c.theta).sort((a, b) => a - b);
      thetaG = angles.length >= 3 ? angles[angles.length >> 1] : 0;
    }

    // 3) 요소별 최종 방향(전체 기울기에서 ±2° 이내로만 보정) + 방향 좌표계의 외접 사각형
    const lim = 2 * DEG, near = 6 * DEG, foot = (sx + sy) / 2;
    const quads = [];
    for (const c of comps) {
      const dev = c.theta - thetaG;
      const th = c.elong >= 4 && Math.abs(dev) <= near ? thetaG + Math.max(-lim, Math.min(lim, dev)) : thetaG;
      const cos = Math.cos(th), sin = Math.sin(th);
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (let k = c.start; k < c.end; k++) {
        const p = order[k], y = (p / W) | 0, x = p - y * W;
        const dx = (x + 0.5) * sx - c.mx, dy = (y + 0.5) * sy - c.my;
        const u = dx * cos + dy * sin, v = -dx * sin + dy * cos;
        if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
      }
      const w0 = u1 - u0 + foot, h0 = v1 - v0 + foot;
      const um = (u0 + u1) / 2, vm = (v0 + v1) / 2;
      const dist = (w0 * h0 * o.unclipRatio) / (2 * (w0 + h0));   // DB unclip: 면적*비율/둘레
      quads.push({
        cx: c.mx + um * cos - vm * sin, cy: c.my + um * sin + vm * cos,
        w: w0 + 2 * dist, h: h0 + 2 * dist, theta: th, score: c.score,
      });
    }
    return { quads, theta: thetaG };
  }

  // ---------- 인식 ----------
  _mask(kind) {
    const key = typeof kind === 'string' ? kind : null;
    const set = key ? WHITELIST[key] : kind.join('');
    const cacheKey = key || set;
    let m = this._masks.get(cacheKey);
    if (!m) {
      const idx = [0];
      for (let i = 1; i < this.chars.length; i++) if (set.includes(this.chars[i]) && this.chars[i] !== '') idx.push(i);
      m = Int32Array.from(idx);
      this._masks.set(cacheKey, m);
    }
    return m;
  }

  /** 이미지 한 장(한 줄)을 인식. whitelist: 'alnum' | 'digits' | null(제한 없음) */
  async recognizeImage(lineImg, whitelist = 'alnum') {
    const o = this.opt;
    const H = o.recHeight;
    let W = Math.ceil((H * lineImg.width) / lineImg.height);
    W = Math.min(Math.max(W, 16), o.recMaxWidth);
    const im = resize(lineImg, W, H);
    const plane = W * H;
    const input = new Float32Array(3 * plane);
    const d = im.data;
    const std = o.recNorm === 'std';
    for (let i = 0, p = 0; i < plane; i++, p += 4) {
      const r = d[p] / 255, g = d[p + 1] / 255, b = d[p + 2] / 255;
      input[i] = std ? (b - 0.5) / 0.5 : b;
      input[plane + i] = std ? (g - 0.5) / 0.5 : g;
      input[2 * plane + i] = std ? (r - 0.5) / 0.5 : r;
    }
    const tensor = new this.ort.Tensor('float32', input, [1, 3, H, W]);
    const out = await this.rec.run({ [this.rec.inputNames[0]]: tensor });
    const t = out[this.rec.outputNames[0]];
    return this._ctcDecode(t.data, t.dims[1], t.dims[2], whitelist);
  }

  _ctcDecode(data, T, C, whitelist) {
    const mask = whitelist ? this._mask(whitelist) : null;
    const chars = [];
    let prev = -1;
    for (let t = 0; t < T; t++) {
      const off = t * C;
      let best = 0, bp = -1;
      if (mask) {
        for (let m = 0; m < mask.length; m++) { const v = data[off + mask[m]]; if (v > bp) { bp = v; best = mask[m]; } }
      } else {
        for (let c = 0; c < C; c++) { const v = data[off + c]; if (v > bp) { bp = v; best = c; } }
      }
      if (best !== 0 && best !== prev) chars.push({ c: this.chars[best] ?? '', p: bp, t });
      prev = best;
    }
    const text = chars.map((x) => x.c).join('');
    const conf = chars.length ? chars.reduce((a, x) => a + x.p, 0) / chars.length : 0;
    return { text, conf, chars, T };
  }

  /** quad({cx,cy,w,h,theta}) 또는 축 정렬 박스({x0,y0,x1,y1}) 영역을 원본 해상도에서 잘라 인식 */
  async recognizeBox(img, box, whitelist = 'alnum') {
    const c = 'theta' in box ? cropRotated(img, box.cx, box.cy, box.w, box.h, box.theta) : crop(img, box.x0, box.y0, box.x1, box.y1);
    return this.recognizeImage(c, whitelist);
  }

  /**
   * 이미지 전체에서 텍스트 줄을 찾아 읽는다.
   * 반환: 위→아래 순 정렬된 줄 목록 [{text, conf, chars, box, quad, rowPos}]
   * @param {object} [o]
   * @param {number} [o.detMaxSide]  이 호출에서만 쓸 검출 해상도 상한
   * @param {number} [o.binThresh]   이 호출에서만 쓸 이진화 임계값
   * @param {(text:string)=>boolean} [o.wholeIf]  참이면 여러 조각으로 나뉜 줄을 합집합 영역으로 통째로 다시 읽음
   * 반환 배열에는 theta(전체 기울기) 속성이 붙는다.
   */
  async recognize(img, { whitelist = 'alnum', onProgress, wholeIf, detMaxSide, binThresh } = {}) {
    const { quads, theta } = await this.detect(img, { maxSide: detMaxSide, binThresh });
    const lines = quads.map((q) => ({ quad: q, box: quadAabb(q), rowPos: uvOf(q.cx, q.cy, theta).v, colPos: uvOf(q.cx, q.cy, theta).u }));
    lines.sort((a, b) => a.rowPos - b.rowPos);
    for (let i = 0; i < lines.length; i++) {
      Object.assign(lines[i], await this.recognizeBox(img, lines[i].quad, whitelist));
      if (onProgress) onProgress(i + 1, lines.length);
    }
    const merged = await this._mergeRows(img, lines, whitelist, wholeIf, theta);
    merged.theta = theta;
    return merged;
  }

  /**
   * 행 위치(rowPos)가 가까운 조각들은 같은 줄로 본다. 조각들의 글자를 이어붙이는 것이 기본이다.
   * wholeIf(이어붙인 텍스트)가 참인 줄은 합집합 영역을 통째로 다시 읽는다.
   * (외딴 글리프를 문맥 없이 읽으면 오독하기 쉬움: 예) ANGLE 뒤의 0 → 9.
   *  반대로 일반 행은 통째로 읽으면 공백이 사라져 숫자가 붙으므로 적용하지 않는다)
   */
  async _mergeRows(img, lines, whitelist, wholeIf, theta) {
    if (!lines.length) return lines;
    const hs = lines.map((l) => l.quad.h).sort((a, b) => a - b);
    const medH = hs[hs.length >> 1];
    const groups = [];
    for (const l of lines) {
      const g = groups.find((gr) => Math.abs(gr.pos - l.rowPos) < medH / 2);
      if (g) { g.items.push(l); g.pos = g.items.reduce((a, x) => a + x.rowPos, 0) / g.items.length; }
      else groups.push({ pos: l.rowPos, items: [l] });
    }
    groups.sort((a, b) => a.pos - b.pos);

    const out = [];
    for (const g of groups) {
      g.items.sort((a, b) => a.colPos - b.colPos);
      if (g.items.length === 1) { out.push(g.items[0]); continue; }
      const quad = unionQuad(g.items.map((i) => i.quad), theta);
      const joined = g.items.map((i) => i.text).join(' ');
      const chars = [];
      g.items.forEach((it, i) => { if (i) chars.push({ c: ' ', p: 1, t: -1 }); chars.push(...it.chars); });
      const result = {
        text: joined, conf: g.items.reduce((a, x) => a + x.conf, 0) / g.items.length, chars,
        quad, box: quadAabb(quad), rowPos: g.pos, colPos: Math.min(...g.items.map((i) => i.colPos)), parts: g.items, merged: true,
      };
      if (wholeIf && wholeIf(joined)) {
        const whole = await this.recognizeBox(img, quad, whitelist);
        // 통째 인식이 충분히 확신될 때만 채택
        if (whole.text.trim().length > 0 && whole.conf >= 0.5) Object.assign(result, whole);
      }
      out.push(result);
    }
    return out;
  }
}
