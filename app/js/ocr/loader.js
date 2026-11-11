// 브라우저에서 OCR 엔진(onnxruntime-web + PP-OCRv4 모델)을 불러오고, 이미지를 RGBA로 디코딩한다.
import * as ort from '../../vendor/ort/ort.wasm.bundle.min.mjs';
import { PaddleEngine } from './engine.js';
import { readExif, orientTransform } from '../exif.js';

let enginePromise = null;

/** 마지막으로 만든 엔진의 실행 방식 (디버그 표시용) */
export const engineInfo = { threads: 1, proxy: false, isolated: false };

/**
 * 같은 출처의 모듈 워커를 만들 수 있는가? ONNX Runtime 의 추론 워커(proxy)와 스레드 워커가 모두 이 방식이다.
 * 앱(WebView)처럼 일부 환경에서는 워커 스크립트 로딩이 막힐 수 있어, 먼저 확인하고 안 되면 메인 스레드로 돌린다.
 * 주소에 ?workers=0 을 붙이면 강제로 메인 스레드 모드 (시험용).
 */
async function workerSupported(timeoutMs = 2500) {
  if (new URLSearchParams(location.search).get('workers') === '0') return false;
  try {
    const w = new Worker(new URL('./probe-worker.js', import.meta.url), { type: 'module' });
    return await new Promise((resolve) => {
      const t = setTimeout(() => { w.terminate(); resolve(false); }, timeoutMs);
      w.onmessage = (e) => { clearTimeout(t); w.terminate(); resolve(e.data === 'ok'); };
      w.onerror = () => { clearTimeout(t); w.terminate(); resolve(false); };
    });
  } catch {
    return false;
  }
}

async function fetchBytes(url, label, onStatus) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${label} 로딩 실패 (${res.status})`);
  onStatus?.(`${label} 내려받는 중…`);
  return new Uint8Array(await res.arrayBuffer());
}

/** 엔진은 한 번만 만든다. onStatus(msg)로 진행 상황을 알린다. */
export function getEngine(onStatus) {
  if (!enginePromise) {
    enginePromise = (async () => {
      const workers = await workerSupported();
      ort.env.wasm.wasmPaths = new URL('../../vendor/ort/', import.meta.url).href;
      // 교차 출처 격리(COOP/COEP)가 켜져 있고 워커를 쓸 수 있을 때만 멀티스레드가 가능하다
      ort.env.wasm.numThreads = workers && self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
      ort.env.wasm.proxy = workers; // 추론을 워커에서 실행해 화면이 멈추지 않게 한다 (워커를 못 쓰면 메인 스레드)
      Object.assign(engineInfo, { threads: ort.env.wasm.numThreads, proxy: workers, isolated: !!self.crossOriginIsolated });

      const base = new URL('../../models/', import.meta.url);
      const [det, rec, dict] = await Promise.all([
        fetchBytes(new URL('det.onnx', base), '검출 모델', onStatus),
        fetchBytes(new URL('rec.onnx', base), '인식 모델', onStatus),
        fetch(new URL('dict.txt', base)).then((r) => {
          if (!r.ok) throw new Error('사전 파일 로딩 실패');
          return r.text();
        }),
      ]);
      onStatus?.('엔진 초기화 중…');
      return PaddleEngine.create({ ort, det, rec, dict, sessionOptions: { executionProviders: ['wasm'] } });
    })().catch((e) => { enginePromise = null; throw e; });
  }
  return enginePromise;
}

/**
 * 이미지 Blob → ImageBitmap (EXIF 회전 반영).
 * 오래된 Safari 는 imageOrientation: 'from-image' 값을 몰라 옵션을 주면 TypeError 를 낸다 →
 * 실패하면 옵션 없이 다시 시도한다 (EXIF 회전은 최신 브라우저에서 옵션 없이도 기본으로 반영된다).
 * 정말 깨진 이미지라면 두 번째 호출도 실패하므로 그 오류가 그대로 올라간다.
 */
async function rawBitmap(blob) {
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    return createImageBitmap(blob);
  }
}

// 크기 4×2 JPEG, EXIF 방향 6. 브라우저가 EXIF 회전을 적용하면 디코드 결과가 2×4 가 된다 (방향값 1~4 는 크기로 구별이 안 돼서 이 시험 결과를 쓴다).
const PROBE_JPEG = '/9j/4QC8RXhpZgAASUkqAAgAAAAGABIBAwABAAAABgAAABoBBQABAAAAVgAAABsBBQABAAAAXgAAACgBAwABAAAAAgAAABMCAwABAAAAAQAAAGmHBAABAAAAZgAAAAAAAAA4YwAA6AMAADhjAADoAwAABgAAkAcABAAAADAyMTABkQcABAAAAAECAwAAoAcABAAAADAxMDABoAMAAQAAAP//AAACoAQAAQAAAAQAAAADoAQAAQAAAAIAAAAAAAAA/9sAQwAQCwwODAoQDg0OEhEQExgoGhgWFhgxIyUdKDozPTw5Mzg3QEhcTkBEV0U3OFBtUVdfYmdoZz5NcXlwZHhcZWdj/9sAQwEREhIYFRgvGhovY0I4QmNjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2Nj/8AAEQgAAgAEAwEiAAIRAQMRAf/EABUAAQEAAAAAAAAAAAAAAAAAAAAG/8QAGBABAQEBAQAAAAAAAAAAAAAAAQIAESH/xAAVAQEBAAAAAAAAAAAAAAAAAAABAv/EABgRAAIDAAAAAAAAAAAAAAAAAAABAjEy/9oADAMBAAIRAxEAPwCjmSZJkCQ4AeBmZhUVLTP/2Q==';
let appliesProbe = null;
/** 이 브라우저(디코드 경로)가 EXIF 회전을 알아서 적용하는가? 한 번만 확인한다. 확인 실패 시 true (= 건드리지 않는 기존 동작). */
function browserAppliesExif() {
  appliesProbe ??= (async () => {
    try {
      const bin = atob(PROBE_JPEG);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const bmp = await rawBitmap(new Blob([bytes], { type: 'image/jpeg' }));
      const applied = bmp.width === 2 && bmp.height === 4;
      bmp.close?.();
      return applied;
    } catch { return true; }
  })();
  return appliesProbe;
}

/** 디코드 결과 bmp 에 EXIF 방향 o 가 이미 반영돼 있는가? 반영 안 됐을 때만 false → 직접 돌린다. */
async function exifAlreadyApplied(bmp, ex) {
  const o = ex.orientation, s = ex.sof;
  if (s && s.width !== s.height && o >= 5 && o <= 8) {         // 방향 5~8 은 가로·세로가 바뀐다 → 크기 비교로 파일마다 확실히 판별
    if (bmp.width === s.height && bmp.height === s.width) return true;
    if (bmp.width === s.width && bmp.height === s.height) return false;
  }
  return browserAppliesExif();                                  // 그 밖(1~4, 정사각형, 크기를 모를 때)은 브라우저 동작 시험 결과
}

/**
 * 이미 만든 bmp 를 EXIF 방향 o 대로 돌려 canvas 로 돌려준다 (canvas 는 width/height/close() 가 있어 ImageBitmap 처럼 쓴다).
 * 캔버스를 못 만들면 bmp 를 그대로 돌려준다 (회전만 포기).
 */
function rotateBitmap(bmp, o, maxSide) {
  const t = orientTransform(o, bmp.width, bmp.height);
  const k = Math.min(1, maxSide / Math.max(t.width, t.height));
  const W = Math.max(1, Math.round(t.width * k)), H = Math.max(1, Math.round(t.height * k));
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  if (!ctx) { c.width = c.height = 0; return bmp; }
  ctx.imageSmoothingQuality = 'high';
  const sx = W / t.width, sy = H / t.height;                    // 축소 배율을 변환에 함께 넣는다
  ctx.setTransform(t.a * sx, t.b * sy, t.c * sx, t.d * sy, t.e * sx, t.f * sy);
  try {
    ctx.drawImage(bmp, 0, 0);
  } catch {
    c.width = c.height = 0;
    return bmp;
  }
  bmp.close?.();
  c.close = () => { c.width = c.height = 0; };
  return c;
}

/**
 * 이미지 Blob → ImageBitmap 비슷한 것 (EXIF 회전 반영, 브라우저가 이미 반영했으면 그대로).
 * 브라우저가 EXIF 회전을 적용하지 않았다고 판별될 때만 직접 돌린다 (이중 회전 방지). maxSide: 직접 돌릴 때 긴 변 상한.
 * 돌려준 값은 .width / .height / drawImage 에 쓸 수 있고, 다 쓰면 .close() 를 부른다.
 */
export async function bitmapFromBlob(blob, { maxSide = 4096 } = {}) {
  const bmp = await rawBitmap(blob);
  try {
    const ex = await readExif(blob);
    if (!ex || ex.orientation < 2) return bmp;                  // JPEG 아님 / EXIF 없음 / 방향 1 → 기존 동작
    if (await exifAlreadyApplied(bmp, ex)) return bmp;
    return rotateBitmap(bmp, ex.orientation, maxSide);
  } catch {
    return bmp;                                                  // EXIF 처리가 어떤 이유로든 실패하면 기존 동작
  }
}

/**
 * 이미지 Blob → { data(RGBA), width, height }. EXIF 회전을 반영하고 긴 변을 maxSide 이하로 줄인다.
 * (4096: 휴대폰 사진에서 기록지가 작게 찍혀도 글자 해상도를 최대한 남기기 위한 값)
 */
export async function decodeImage(blob, maxSide = 4096) {
  const bmp = await bitmapFromBlob(blob, { maxSide });
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * k));
  const h = Math.max(1, Math.round(bmp.height * k));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';           // 투명 PNG 대비
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const id = ctx.getImageData(0, 0, w, h);
  canvas.width = canvas.height = 0;   // 캔버스 메모리를 바로 돌려준다 (iOS Safari 는 캔버스 메모리 총량에 한도가 있다)
  return { data: id.data, width: w, height: h };
}

/**
 * RGBA 이미지를 deg(시계방향 0/90/180/270)만큼 돌려 canvas에 그린다 (미리보기용이라 긴 변 maxPreview 로 줄여서 그림).
 * 반환: 회전된 "원본 해상도" 크기 — 박스 좌표(원본 픽셀 기준)를 퍼센트로 바꿀 때 쓴다.
 */
export function drawRotated(canvas, img, deg, maxPreview = 2000) {
  const src = document.createElement('canvas');
  src.width = img.width; src.height = img.height;
  src.getContext('2d').putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
  const swap = deg % 180 !== 0;
  const fullW = swap ? img.height : img.width, fullH = swap ? img.width : img.height;
  const k = Math.min(1, maxPreview / Math.max(fullW, fullH));
  canvas.width = Math.round(fullW * k);
  canvas.height = Math.round(fullH * k);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.save();
  ctx.scale(k, k);
  if (deg === 90) { ctx.translate(fullW, 0); ctx.rotate(Math.PI / 2); }
  else if (deg === 180) { ctx.translate(fullW, fullH); ctx.rotate(Math.PI); }
  else if (deg === 270) { ctx.translate(0, fullH); ctx.rotate(-Math.PI / 2); }
  ctx.drawImage(src, 0, 0);
  ctx.restore();
  src.width = src.height = 0;         // 원본 크기 임시 캔버스는 바로 비운다 (iOS Safari 캔버스 메모리 한도)
  return { width: fullW, height: fullH };
}
