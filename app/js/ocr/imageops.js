// 환경 무관 RGBA 이미지 연산 (브라우저/Node 공용).
// 이미지 표현: { data: Uint8ClampedArray(RGBA), width, height }

export function crop(img, x0, y0, x1, y1) {
  x0 = Math.max(0, Math.floor(x0));
  y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(img.width, Math.ceil(x1));
  y1 = Math.min(img.height, Math.ceil(y1));
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const s = ((y0 + y) * img.width + x0) * 4;
    out.set(img.data.subarray(s, s + w * 4), y * w * 4);
  }
  return { data: out, width: w, height: h };
}

/** 시계방향 90도 단위 회전 (deg: 0/90/180/270) */
export function rotate(img, deg) {
  deg = ((deg % 360) + 360) % 360;
  if (deg === 0) return img;
  const { width: w, height: h, data } = img;
  if (deg === 180) {
    const out = new Uint8ClampedArray(data.length);
    for (let i = 0, n = w * h; i < n; i++) {
      const j = (n - 1 - i) * 4;
      out[j] = data[i * 4]; out[j + 1] = data[i * 4 + 1]; out[j + 2] = data[i * 4 + 2]; out[j + 3] = data[i * 4 + 3];
    }
    return { data: out, width: w, height: h };
  }
  const out = new Uint8ClampedArray(data.length);
  const nw = h, nh = w;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = deg === 90 ? h - 1 - y : y;
      const ny = deg === 90 ? x : w - 1 - x;
      const s = (y * w + x) * 4, d = (ny * nw + nx) * 4;
      out[d] = data[s]; out[d + 1] = data[s + 1]; out[d + 2] = data[s + 2]; out[d + 3] = data[s + 3];
    }
  }
  return { data: out, width: nw, height: nh };
}

// 한 축 리샘플 가중치 (삼각 필터, 축소 시 지지 영역 확대 = 안티에일리어싱)
function axisWeights(srcLen, dstLen) {
  const scale = srcLen / dstLen;
  const support = Math.max(1, scale);
  const idx = new Array(dstLen);
  const wts = new Array(dstLen);
  for (let i = 0; i < dstLen; i++) {
    const center = (i + 0.5) * scale;
    const lo = Math.max(0, Math.floor(center - support));
    const hi = Math.min(srcLen - 1, Math.ceil(center + support) - 1);
    const w = [];
    let sum = 0;
    for (let j = lo; j <= hi; j++) {
      const v = Math.max(0, 1 - Math.abs((j + 0.5 - center) / support));
      w.push(v);
      sum += v;
    }
    if (sum === 0) { w.length = 0; w.push(1); sum = 1; idx[i] = Math.min(srcLen - 1, Math.max(0, Math.floor(center))); } else idx[i] = lo;
    for (let k = 0; k < w.length; k++) w[k] /= sum;
    wts[i] = w;
  }
  return { idx, wts };
}

export function resize(img, dw, dh) {
  dw = Math.max(1, Math.round(dw));
  dh = Math.max(1, Math.round(dh));
  if (dw === img.width && dh === img.height) return img;
  const { width: sw, height: sh, data } = img;

  // 가로 패스: sw -> dw (높이 sh 유지)
  const ax = axisWeights(sw, dw);
  const tmp = new Float32Array(dw * sh * 4);
  for (let y = 0; y < sh; y++) {
    const row = y * sw * 4;
    for (let x = 0; x < dw; x++) {
      const w = ax.wts[x], base = ax.idx[x];
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < w.length; k++) {
        const s = row + (base + k) * 4, wk = w[k];
        r += data[s] * wk; g += data[s + 1] * wk; b += data[s + 2] * wk; a += data[s + 3] * wk;
      }
      const d = (y * dw + x) * 4;
      tmp[d] = r; tmp[d + 1] = g; tmp[d + 2] = b; tmp[d + 3] = a;
    }
  }
  // 세로 패스: sh -> dh
  const ay = axisWeights(sh, dh);
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const w = ay.wts[y], base = ay.idx[y];
    for (let x = 0; x < dw; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < w.length; k++) {
        const s = ((base + k) * dw + x) * 4, wk = w[k];
        r += tmp[s] * wk; g += tmp[s + 1] * wk; b += tmp[s + 2] * wk; a += tmp[s + 3] * wk;
      }
      const d = (y * dw + x) * 4;
      out[d] = r; out[d + 1] = g; out[d + 2] = b; out[d + 3] = a;
    }
  }
  return { data: out, width: dw, height: dh };
}

/**
 * 회전된 사각형을 똑바로 펴서 잘라낸다 (PaddleOCR의 get_rotate_crop_image 와 같은 역할).
 * (cx,cy): 중심, w×h: 크기, theta: 가로축의 기울기(라디안, 시계방향이 +). 영역 밖은 흰색.
 */
export function cropRotated(img, cx, cy, w, h, theta) {
  const ow = Math.max(1, Math.round(w));
  const oh = Math.max(1, Math.round(h));
  const out = new Uint8ClampedArray(ow * oh * 4);
  const { data, width: W, height: H } = img;
  const cos = Math.cos(theta), sin = Math.sin(theta);
  const kx = w / ow, ky = h / oh;
  for (let j = 0; j < oh; j++) {
    const v = (j + 0.5) * ky - h / 2;
    for (let i = 0; i < ow; i++) {
      const u = (i + 0.5) * kx - w / 2;
      const x = cx + u * cos - v * sin - 0.5;
      const y = cy + u * sin + v * cos - 0.5;
      const d = (j * ow + i) * 4;
      if (x < -1 || y < -1 || x > W || y > H) { out[d] = out[d + 1] = out[d + 2] = 255; out[d + 3] = 255; continue; }
      const x0 = Math.floor(x), y0 = Math.floor(y);
      const fx = x - x0, fy = y - y0;
      const xa = Math.min(W - 1, Math.max(0, x0)), xb = Math.min(W - 1, Math.max(0, x0 + 1));
      const ya = Math.min(H - 1, Math.max(0, y0)), yb = Math.min(H - 1, Math.max(0, y0 + 1));
      const p00 = (ya * W + xa) * 4, p10 = (ya * W + xb) * 4, p01 = (yb * W + xa) * 4, p11 = (yb * W + xb) * 4;
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      out[d] = data[p00] * w00 + data[p10] * w10 + data[p01] * w01 + data[p11] * w11;
      out[d + 1] = data[p00 + 1] * w00 + data[p10 + 1] * w10 + data[p01 + 1] * w01 + data[p11 + 1] * w11;
      out[d + 2] = data[p00 + 2] * w00 + data[p10 + 2] * w10 + data[p01 + 2] * w01 + data[p11 + 2] * w11;
      out[d + 3] = 255;
    }
  }
  return { data: out, width: ow, height: oh };
}

/** 같은 높이의 이미지들을 흰 여백(gaps[i]px)을 두고 가로로 이어붙인다 */
export function hstack(imgs, gaps, pad = 0) {
  const h = Math.max(...imgs.map((i) => i.height)) + pad * 2;
  const gapOf = (i) => (Array.isArray(gaps) ? gaps[i] : gaps);
  let w = pad * 2;
  imgs.forEach((im, i) => { w += im.width + (i ? Math.round(gapOf(i - 1)) : 0); });
  const out = new Uint8ClampedArray(w * h * 4).fill(255);
  let x = pad;
  imgs.forEach((im, i) => {
    if (i) x += Math.round(gapOf(i - 1));
    const y0 = Math.round((h - im.height) / 2);
    for (let y = 0; y < im.height; y++) out.set(im.data.subarray(y * im.width * 4, (y + 1) * im.width * 4), ((y0 + y) * w + x) * 4);
    x += im.width;
  });
  return { data: out, width: w, height: h };
}

/** 휘도 (0~255) */
const luma = (d, p) => 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];

/** 격자 칸마다 종이 밝기(상위 85% 휘도)를 추정한다. { grid, cols, rows, cell } */
function paperBrightness(img, cellTarget = 12) {
  const { data, width: w, height: h } = img;
  const cell = Math.max(48, Math.round(Math.min(w, h) / cellTarget));
  const cols = Math.max(1, Math.ceil(w / cell)), rows = Math.max(1, Math.ceil(h / cell));
  const grid = new Float32Array(cols * rows);
  const stride = Math.max(1, Math.round(cell / 24));
  const hist = new Uint32Array(256);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      hist.fill(0);
      let n = 0;
      const y1 = Math.min(h, (r + 1) * cell), x1 = Math.min(w, (c + 1) * cell);
      for (let y = r * cell; y < y1; y += stride) {
        for (let x = c * cell; x < x1; x += stride) { hist[Math.round(luma(data, (y * w + x) * 4))]++; n++; }
      }
      let acc = 0, target = n * 0.85, v = 0;
      for (; v < 255; v++) { acc += hist[v]; if (acc >= target) break; }
      grid[r * cols + c] = v;
    }
  }
  return { grid, cols, rows, cell };
}

/** 조명 상태 요약: 종이 밝기 중앙값과 밝은 곳/어두운 곳의 비 (1에 가까울수록 균일) */
export function analyzeIllumination(img) {
  const { grid } = paperBrightness(img);
  const s = [...grid].sort((a, b) => a - b);
  const median = s[s.length >> 1];
  const lo = s[Math.floor(s.length * 0.1)], hi = s[Math.floor(s.length * 0.9)];
  return { median, unevenness: hi / Math.max(lo, 1) };
}

/**
 * 조명 균일화: 종이 밝기를 추정해 어둡거나 그림자진 곳을 밝힌다 (밝은 곳은 그대로).
 * 어두운 사진, 한쪽에 그림자가 진 사진에서 글자 대비를 되살린다.
 */
export function normalizeIllumination(img, { target = 238, gainMax = 2.8 } = {}) {
  const { data, width: w, height: h } = img;
  const { grid, cols, rows, cell } = paperBrightness(img);
  const gains = new Float32Array(cols * rows);
  for (let i = 0; i < gains.length; i++) gains[i] = Math.max(1, Math.min(gainMax, target / Math.max(grid[i], 1)));
  const clampC = (c) => (c < 0 ? 0 : c >= cols ? cols - 1 : c);
  const clampR = (r) => (r < 0 ? 0 : r >= rows ? rows - 1 : r);

  // x 방향 보간 계수는 행마다 같으므로 미리 계산
  const xa = new Int32Array(w), xb = new Int32Array(w), xf = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    const gx = (x + 0.5) / cell - 0.5, c0 = Math.floor(gx);
    xa[x] = clampC(c0); xb[x] = clampC(c0 + 1); xf[x] = gx - c0;
  }
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < h; y++) {
    const gy = (y + 0.5) / cell - 0.5, r0 = Math.floor(gy), fy = gy - r0;
    const ra = clampR(r0) * cols, rb = clampR(r0 + 1) * cols;
    for (let x = 0; x < w; x++) {
      const f = xf[x];
      const top = gains[ra + xa[x]] * (1 - f) + gains[ra + xb[x]] * f;
      const bot = gains[rb + xa[x]] * (1 - f) + gains[rb + xb[x]] * f;
      const g = top * (1 - fy) + bot * fy;
      const p = (y * w + x) * 4;
      out[p] = data[p] * g; out[p + 1] = data[p + 1] * g; out[p + 2] = data[p + 2] * g; out[p + 3] = 255;
    }
  }
  return { data: out, width: w, height: h };
}

/** 알파를 흰 배경으로 합성해 불투명하게 만든다 (PNG 투명 배경 대비) */
export function flattenOnWhite(img) {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    if (a === 255) continue;
    const k = a / 255;
    d[i] = d[i] * k + 255 * (1 - k);
    d[i + 1] = d[i + 1] * k + 255 * (1 - k);
    d[i + 2] = d[i + 2] * k + 255 * (1 - k);
    d[i + 3] = 255;
  }
  return img;
}
